// Оркестрация: события мыши на canvas, переключение фаз редактор/гонка.

import './styles/index.css';
import { Vec, dist } from './geometry';
import { Track, WORLD_W, WORLD_H, finalizeTrack, setWorldSize } from './track';
import {
  newEditor,
  pointerDown,
  pointerMove,
  pointerUp,
  pointerCancel,
  stepBack,
  confirmEdges,
} from './editor';
import { GameState, Candidate, newGame, candidates, applyMove } from './game';
import { render, AppView } from './render';
import { bindButtons, updatePanel, showConfirmMove, PanelMode } from './ui';
import { localizeDom } from './localize';
import {
  TOUCH_LIFT,
  CELL_MIN,
  CELL_MAX,
  TOUCH_TOL_PX,
  ZOOM_MAX,
  LOUPE_MAX_CELL_PX,
} from './config';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const wrap = document.querySelector('.app__board')!;

let mode: PanelMode = 'edit';
let editor = newEditor();
/**
 * Готовая трасса, ожидающая выбора числа игроков (шаг «players»). Приходит либо
 * из редактора после выбора направления, либо из «Новая гонка → та же трасса».
 */
let raceTrack: Track | null = null;
/** Куда вернуться из шага выбора игроков по «Назад»: в редактор или в гонку. */
let playersReturn: 'edit' | 'race' = 'edit';
let game: GameState | null = null;
let cands: Candidate[] | null = null;
let hover: Candidate | null = null;
/** Тач: кандидат, выбранный первым касанием и ждущий подтверждения. */
let selected: Candidate | null = null;
/** Тач: позиция пальца (css-px canvas) во время прицеливания — включает лупу. */
let loupe: Vec | null = null;
let cellPx = 16;
/**
 * Размеры мира зафиксированы: поле уже «занято» (начата трасса / идёт гонка),
 * поэтому при повороте/ресайзе число клеток не пересчитывается — меняется лишь
 * cellPx. Пока false, число клеток подбирается под пропорции доски.
 */
let worldLocked = false;
/** Пинч-зум трассы в гонке: множитель к вписанной сетке и смещение (css-px). */
let zoom = 1;
let panX = 0;
let panY = 0;
/** Активные тач-указатели (для распознавания пинча двумя пальцами). */
const activePointers = new Map<number, Vec>();
/** Снимок начала пинч-жеста; null — пинча нет. */
let pinch:
  | { d0: number; midX: number; midY: number; zoom0: number; panX0: number; panY0: number }
  | null = null;

/** Эффективный размер клетки на экране с учётом пинч-зума, css-px. */
function effCell(): number {
  return cellPx * zoom;
}

/** Радиус попадания по кандидату в клетках: для пальца — не меньше TOUCH_TOL_PX. */
function touchTol(): number {
  return Math.max(0.45, TOUCH_TOL_PX / effCell());
}

/** Сбросить пинч-зум/пан (при старте гонки, новой трассе, ресайзе). */
function resetView(): void {
  zoom = 1;
  panX = 0;
  panY = 0;
  pinch = null;
}

/**
 * Ограничить пан так, чтобы трасса не «уезжала» из вида: пока доска целиком
 * помещается по оси — держим её у левого/верхнего края (как без зума), иначе
 * даём панорамировать в пределах [контейнер − доска, 0].
 */
function clampView(): void {
  const r = wrap.getBoundingClientRect();
  const boardW = WORLD_W * effCell();
  const boardH = WORLD_H * effCell();
  panX = boardW <= r.width ? 0 : Math.min(0, Math.max(r.width - boardW, panX));
  panY = boardH <= r.height ? 0 : Math.min(0, Math.max(r.height - boardH, panY));
}

function resize(): void {
  const r = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (worldLocked) {
    // Мир зафиксирован (идёт рисование/гонка): число клеток не трогаем при
    // повороте/ресайзе — только вписываем фикс. сетку без искажений (letterbox).
    cellPx = Math.min(r.width / WORLD_W, r.height / WORLD_H);
  } else {
    // Поле ещё пустое: подбираем число клеток под пропорции доски. ceil (а не
    // min/floor) → сетка покрывает доску целиком, без пустой полосы.
    const cell = Math.max(CELL_MIN, Math.min(CELL_MAX, Math.min(r.width, r.height) / 30));
    setWorldSize(
      Math.max(8, Math.ceil(r.width / cell)),
      Math.max(8, Math.ceil(r.height / cell)),
    );
    cellPx = cell;
  }
  // Меняются пропорции сетки — начинаем с вписанного вида без зума.
  resetView();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  canvas.style.width = `${r.width}px`;
  canvas.style.height = `${r.height}px`;
  redraw();
}

function redraw(): void {
  // Шаг выбора игроков рисуется как редактор: показываем готовую трассу-превью.
  const viewMode = mode === 'race' ? 'race' : 'edit';
  const app: AppView = {
    mode: viewMode,
    editor,
    game,
    cands,
    hover,
    selected,
    loupe,
    cellPx,
    zoom,
    panX,
    panY,
  };
  render(ctx, app);
}

function updateUI(): void {
  updatePanel(mode, editor, game, raceTrack?.startPoints.length ?? 6);
}

function toScreen(e: PointerEvent): Vec {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function toWorld(e: PointerEvent, liftPx = 0): Vec {
  const p = toScreen(e);
  const s = effCell();
  return {
    x: Math.max(0, Math.min(WORLD_W, (p.x - panX) / s)),
    y: Math.max(0, Math.min(WORLD_H, (p.y - liftPx - panY) / s)),
  };
}

/**
 * Смещение точки рисования вверх — только при freehand-рисовании края пальцем.
 * Протяжка финиша и тап по стрелкам остаются точно под пальцем (лифт = 0).
 */
function drawLift(e: PointerEvent): number {
  return e.pointerType === 'touch' &&
    mode === 'edit' &&
    (editor.phase === 'center' || editor.phase === 'adjust')
    ? TOUCH_LIFT
    : 0;
}

/** Экранная точка прицела для тач-гонки: положение пальца, поднятое на TOUCH_LIFT. */
function aimScreen(e: PointerEvent): Vec {
  const s = toScreen(e);
  return { x: s.x, y: s.y - TOUCH_LIFT };
}

function refreshCands(): void {
  hover = null;
  selected = null;
  loupe = null;
  showConfirmMove(false);
  if (game && game.phase === 'race' && game.players[game.current].skipTurns === 0) {
    cands = candidates(game);
  } else {
    cands = null;
  }
}

function findCandidate(w: Vec, tol = 0.45): Candidate | null {
  if (!cands) return null;
  let best: Candidate | null = null;
  let bestD = tol;
  for (const c of cands) {
    if (c.blocked) continue;
    const d = dist(w, c.target);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** id активного тач-указателя (прицельный палец); второй палец уходит в пинч. */
let touchId: number | null = null;

/** Идёт ли гонка с активным игроком, по которому можно прицеливаться/зумить. */
function racing(): boolean {
  return mode === 'race' && game !== null && game.phase === 'race';
}

/** Два активных тач-указателя (для пинча). */
function pinchPoints(): [Vec, Vec] {
  const v = [...activePointers.values()];
  return [v[0], v[1]];
}

/** Начать пинч-жест по текущим двум пальцам, прервав прицеливание. */
function startPinch(): void {
  const [a, b] = pinchPoints();
  pinch = {
    d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
    zoom0: zoom,
    panX0: panX,
    panY0: panY,
  };
  touchId = null;
  loupe = null;
  hover = null;
  selected = null;
  showConfirmMove(false);
}

/** Пересчитать зум/пан по текущим двум пальцам: точка мира под центром жеста
 *  остаётся под центром, расстояние между пальцами задаёт масштаб. */
function updatePinch(): void {
  if (!pinch) return;
  const [a, b] = pinchPoints();
  const d1 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  const mid1x = (a.x + b.x) / 2;
  const mid1y = (a.y + b.y) / 2;
  const nz = Math.max(1, Math.min(ZOOM_MAX, pinch.zoom0 * (d1 / pinch.d0)));
  panX = mid1x - (pinch.midX - pinch.panX0) * (nz / pinch.zoom0);
  panY = mid1y - (pinch.midY - pinch.panY0) * (nz / pinch.zoom0);
  zoom = nz;
  clampView();
}

/** Прицеливание пальцем: подсветить ближайшего кандидата; лупу показывать лишь
 *  пока клетки мелкие — при достаточном зуме точки и так легко тапнуть. */
function aimAt(e: PointerEvent): void {
  hover = findCandidate(toWorld(e, TOUCH_LIFT), touchTol());
  loupe = effCell() < LOUPE_MAX_CELL_PX ? aimScreen(e) : null;
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  // setPointerCapture кидает NotFoundError для уже неактивного указателя.
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {}
  const touch = e.pointerType === 'touch';
  if (touch) activePointers.set(e.pointerId, toScreen(e));

  // Второй палец в гонке — начинаем пинч-зум (прерывая прицеливание).
  if (touch && racing() && activePointers.size === 2) {
    startPinch();
    redraw();
    return;
  }
  if (touch) {
    // Уже идёт пинч или уже есть прицельный палец — новый палец игнорируем.
    if (pinch || touchId !== null) return;
    touchId = e.pointerId;
  }
  const w = toWorld(e, drawLift(e));
  if (mode === 'edit') {
    // Пользователь коснулся доски — мир «занят», фиксируем число клеток.
    worldLocked = true;
    const tol = touch ? Math.max(1.2, TOUCH_TOL_PX / cellPx) : 1.2;
    pointerDown(editor, w, tol);
    if (editor.phase === 'ready') { goToPlayers('edit'); return; }
    updateUI();
  } else if (game && game.phase === 'race') {
    if (touch) {
      aimAt(e);
    } else {
      const c = findCandidate(w);
      if (c) {
        applyMove(game, c);
        refreshCands();
        updateUI();
      }
    }
  }
  redraw();
});

canvas.addEventListener('pointermove', (e) => {
  const touch = e.pointerType === 'touch';
  if (touch) {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, toScreen(e));
  }
  if (pinch && activePointers.size >= 2) {
    updatePinch();
    redraw();
    return;
  }
  if (touch && e.pointerId !== touchId) return;
  const w = toWorld(e, drawLift(e));
  if (mode === 'edit') {
    pointerMove(editor, w);
    redraw();
  } else if (touch) {
    aimAt(e);
    redraw();
  } else {
    const c = findCandidate(w);
    if (c !== hover) {
      hover = c;
      redraw();
    }
  }
});

canvas.addEventListener('pointerup', (e) => {
  const touch = e.pointerType === 'touch';
  if (touch) activePointers.delete(e.pointerId);

  if (pinch) {
    // Завершение пинча: когда пальцев осталось меньше двух — выходим из жеста.
    // Палец, завершивший пинч, ход НЕ выбирает.
    if (activePointers.size < 2) pinch = null;
    redraw();
    return;
  }
  if (touch) {
    if (e.pointerId !== touchId) return;
    touchId = null;
  }
  if (mode === 'edit') {
    pointerMove(editor, toWorld(e, drawLift(e)));
    pointerUp(editor);
    updateUI();
    redraw();
  } else if (touch && game && game.phase === 'race') {
    // Отпускание пальца: выбрать кандидата (превью траектории + плавающая
    // кнопка «Ходить»); мимо кандидатов — сброс выбора. Подтверждение — кнопкой.
    loupe = null;
    hover = null;
    selected = findCandidate(toWorld(e, TOUCH_LIFT), touchTol());
    showConfirmMove(!!selected);
    redraw();
  }
});

canvas.addEventListener('pointercancel', (e) => {
  const touch = e.pointerType === 'touch';
  if (touch) activePointers.delete(e.pointerId);
  if (pinch) {
    if (activePointers.size < 2) pinch = null;
    redraw();
    return;
  }
  if (touch && e.pointerId !== touchId) return;
  touchId = null;
  loupe = null;
  hover = null;
  if (mode === 'edit') pointerCancel(editor);
  redraw();
});

/**
 * Перейти к шагу выбора числа игроков. Из редактора («edit») сначала
 * финализируем нарисованную трассу; если это не удалось — показываем ошибку и
 * остаёмся в редакторе. Из гонки («race», кнопка «та же трасса») берём готовую
 * трассу текущей гонки.
 */
function goToPlayers(from: 'edit' | 'race'): void {
  if (from === 'edit') {
    const res = finalizeTrack(editor.outer!, editor.inner!, editor.finish!, editor.forward!);
    if ('error' in res) {
      editor.message = res.error;
      editor.error = true;
      updateUI();
      redraw();
      return;
    }
    raceTrack = res.track;
  } else {
    if (!game) return;
    raceTrack = game.track;
  }
  playersReturn = from;
  mode = 'players';
  updateUI();
  redraw();
}

/** Выбрано число игроков — стартуем гонку на подготовленной трассе. */
function startRace(playerCount: number): void {
  if (!raceTrack) return;
  game = newGame(raceTrack, playerCount);
  mode = 'race';
  resetView();
  refreshCands();
  updateUI();
  redraw();
}

bindButtons({
  onBack: () => {
    stepBack(editor);
    updateUI();
    redraw();
  },
  onNext: () => {
    confirmEdges(editor);
    updateUI();
    redraw();
  },
  onConfirmMove: () => {
    if (!selected || !game || game.phase !== 'race') return;
    applyMove(game, selected);
    refreshCands();
    updateUI();
    redraw();
  },
  onChooseSameTrack: () => goToPlayers('race'),
  onPlayersBack: () => {
    if (playersReturn === 'race') {
      // Вернуться к текущей гонке без изменений.
      mode = 'race';
    } else {
      // Вернуться в редактор на шаг выбора направления.
      mode = 'edit';
      stepBack(editor); // ready → direction
    }
    raceTrack = null;
    updateUI();
    redraw();
  },
  onPlayerCount: (n) => startRace(n),
  onNewTrack: () => {
    mode = 'edit';
    game = null;
    raceTrack = null;
    cands = null;
    hover = null;
    selected = null;
    showConfirmMove(false);
    editor = newEditor();
    // Снять фиксацию: новая трасса берёт пропорции под текущую ориентацию.
    worldLocked = false;
    updateUI();
    resize(); // пере-вывести мир под текущую ориентацию + redraw
  },
});

// Заполнить статичные тексты разметки из strings до первого показа панели.
localizeDom();

// ResizeObserver вместо window.resize: обёртка меняет размер и при смене
// раскладки (портрет/ландшафт на мобильных), а не только окна.
new ResizeObserver(resize).observe(wrap);
updateUI();
resize();
