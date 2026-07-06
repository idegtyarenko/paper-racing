// Оркестрация: события мыши на canvas, переключение фаз редактор/гонка.

import './styles/index.css';
import { Vec, dist } from './geometry';
import { Track, finalizeTrack } from './track';
import {
  newEditor,
  editorFromTrack,
  pointerDown,
  pointerMove,
  pointerUp,
  pointerCancel,
  stepBack,
  confirmEdges,
} from './editor';
import { GameState, Candidate, newGame, candidates, applyMove, seatColor } from './game';
import { render, AppView } from './render';
import { Bounds, worldToScreen, polylineBounds, clampScale } from './camera';
import * as vp from './viewport';
import {
  bindButtons,
  updatePanel,
  showConfirmMove,
  renderLobby,
  openNameDialog,
  openJoinDialog,
  showJoinError,
  showToast,
  setOnlineEnabled,
  closeOverlay,
  PanelMode,
} from './ui';
import { localizeDom } from './localize';
import { strings } from './strings';
import { onlineAvailable } from './net';
import * as session from './online';
import { OnlineHandlers } from './online';
import { initInstallPrompt } from './install-prompt';
import {
  TOUCH_LIFT,
  TOUCH_TOL_PX,
  LOUPE_MAX_CELL_PX,
  AIM_ZONE_PX,
  DRAG_PX,
  ZOOM_BTN_FACTOR,
  WHEEL_FACTOR,
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
/** Активные тач-указатели (для распознавания пинча двумя пальцами). */
const activePointers = new Map<number, Vec>();
/** Снимок начала пинч-жеста; null — пинча нет. */
let pinch: {
  d0: number;
  midX: number;
  midY: number;
  scale0: number;
  ox0: number;
  oy0: number;
} | null = null;

/**
 * Текущий жест одним указателем. `activeId` — id владеющего указателя (второй
 * палец уводит в пинч, прочие игнорируются). Часть жестов (finish/move) на драге
 * превращается в пан.
 */
type Gesture =
  | { kind: 'draw' } // рисование осевой (center)
  | { kind: 'edge' } // тюнинг кромки (adjust)
  | { kind: 'finish'; downX: number; downY: number } // тап-финиш; драг → пан
  | { kind: 'aim' } // тач-прицеливание в гонке (лупа)
  | { kind: 'move'; cand: Candidate; downX: number; downY: number } // мышь-ход; драг → пан
  | { kind: 'pan'; ox0: number; oy0: number; sx0: number; sy0: number };
let gesture: Gesture | null = null;
let activeId: number | null = null;

/** Радиус попадания по кандидату в клетках: для пальца — не меньше TOUCH_TOL_PX. */
function touchTol(): number {
  return Math.max(0.45, TOUCH_TOL_PX / vp.scale());
}

/** Bbox содержимого для fit/clamp: трасса гонки или редактируемая трасса.
 *  Провайдер границ для вьюпорта — «что сейчас на экране» знает приложение. */
function contentBounds(): Bounds | null {
  if (mode === 'race' && game) return polylineBounds(game.track.outer, game.track.inner);
  return polylineBounds(editor.outer, editor.inner, editor.center);
}

/** Нужен ли лифт точки над пальцем при прицеливании — пока клетки мелкие. */
function loupeActive(): boolean {
  return vp.scale() < LOUPE_MAX_CELL_PX;
}

/** Пересчитать вьюпорт под новый размер поля и перерисовать. */
function resize(): void {
  vp.resize();
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
    cam: vp.camera(),
  };
  render(ctx, app);
}

function updateUI(): void {
  const net = session.active() && game ? { yourTurn: myTurn() } : null;
  updatePanel(mode, editor, game, raceTrack?.startPoints.length ?? 6, net);
}

/** Может ли этот клиент ходить сейчас: в локальной игре — всегда, в онлайне — на своём месте. */
function myTurn(): boolean {
  if (!session.active()) return true;
  return game !== null && session.mySeat() === game.current;
}

/**
 * Применить выбранный ход: локально мутируем стейт, а в онлайне ещё и отправляем
 * его остальным. Не даём ходить не в свой ход / не в фазе гонки.
 */
function commitMove(cand: Candidate): void {
  if (!game || game.phase !== 'race' || !myTurn()) return;
  applyMove(game, cand);
  refreshCands();
  updateUI();
  redraw();
  if (session.active())
    session.pushMove(game).catch(() => showToast(strings.online.error));
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
  const s = vp.toScreen(e);
  return { x: s.x, y: s.y - TOUCH_LIFT };
}

function refreshCands(): void {
  hover = null;
  selected = null;
  loupe = null;
  showConfirmMove(false);
  if (
    game &&
    game.phase === 'race' &&
    game.players[game.current].skipTurns === 0 &&
    myTurn()
  ) {
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

/** Два активных тач-указателя (для пинча). */
function pinchPoints(): [Vec, Vec] {
  const v = [...activePointers.values()];
  return [v[0], v[1]];
}

/** Начать пинч-жест по текущим двум пальцам, прервав любой одиночный жест. */
function startPinch(): void {
  const [a, b] = pinchPoints();
  const c = vp.camera();
  pinch = {
    d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
    scale0: c.scale,
    ox0: c.ox,
    oy0: c.oy,
  };
  gesture = null;
  activeId = null;
  loupe = null;
  hover = null;
  selected = null;
  canvas.classList.remove('grabbing');
  showConfirmMove(false);
}

/** Пересчитать масштаб/пан по двум пальцам: мировая точка под центром жеста
 *  остаётся под центром, расстояние между пальцами задаёт масштаб. */
function updatePinch(): void {
  if (!pinch) return;
  const [a, b] = pinchPoints();
  const d1 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  const mid1x = (a.x + b.x) / 2;
  const mid1y = (a.y + b.y) / 2;
  const nscale = clampScale(pinch.scale0 * (d1 / pinch.d0));
  const k = nscale / pinch.scale0;
  vp.applyUserCamera({
    scale: nscale,
    ox: mid1x - (pinch.midX - pinch.ox0) * k,
    oy: mid1y - (pinch.midY - pinch.oy0) * k,
  });
}

/** Подъём точки прицела над пальцем — только когда есть лупа (иначе палец
 *  закрыл бы точку). Без лупы пользователь тапает ровно в точку, лифт = 0. */
function aimLift(): number {
  return loupeActive() ? TOUCH_LIFT : 0;
}

/** Прицеливание пальцем: подсветить ближайшего кандидата и (если нужна) лупу. */
function aimAt(e: PointerEvent): void {
  hover = findCandidate(vp.toWorld(e, aimLift()), touchTol());
  loupe = loupeActive() ? aimScreen(e) : null;
}

/** Ближайший (незаблокированный) кандидат к экранной точке, в css-px. */
function nearestCandScreen(scr: Vec): { cand: Candidate; dist: number } | null {
  if (!cands) return null;
  let best: Candidate | null = null;
  let bestD = Infinity;
  const view = vp.camera();
  for (const c of cands) {
    if (c.blocked) continue;
    const p = worldToScreen(view, c.target);
    const d = Math.hypot(p.x - scr.x, p.y - scr.y);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best ? { cand: best, dist: bestD } : null;
}

/** Начать пан карты одним указателем от экранной точки. */
function beginPan(sx: number, sy: number, id: number): void {
  const c = vp.camera();
  gesture = { kind: 'pan', ox0: c.ox, oy0: c.oy, sx0: sx, sy0: sy };
  activeId = id;
  loupe = null;
  hover = null;
  selected = null;
  showConfirmMove(false);
  canvas.classList.add('grabbing');
}

/** Сдвинуть камеру за указателем (жест pan). */
function movePan(scr: Vec): void {
  if (gesture?.kind !== 'pan') return;
  vp.applyUserCamera({
    scale: vp.scale(),
    ox: gesture.ox0 + (scr.x - gesture.sx0),
    oy: gesture.oy0 + (scr.y - gesture.sy0),
  });
}

/** Классификация касания в редакторе: рисование/тюнинг/финиш/стрелка либо пан. */
function handleEditDown(e: PointerEvent, scr: Vec, touch: boolean): void {
  const w = vp.toWorld(e, drawLift(e));
  const tol = touch ? Math.max(1.2, TOUCH_TOL_PX / vp.scale()) : 1.2;
  const phase = editor.phase;
  switch (phase) {
    case 'center':
      pointerDown(editor, w, tol);
      gesture = { kind: 'draw' };
      activeId = e.pointerId;
      break;
    case 'adjust':
      pointerDown(editor, w, tol);
      if (editor.dragEdge) {
        gesture = { kind: 'edge' };
        activeId = e.pointerId;
      } else {
        beginPan(scr.x, scr.y, e.pointerId);
      }
      break;
    case 'finish':
      pointerDown(editor, w, tol); // ставит dragStart + превью финиша
      gesture = { kind: 'finish', downX: scr.x, downY: scr.y };
      activeId = e.pointerId;
      break;
    case 'direction':
      pointerDown(editor, w, tol); // тап по стрелке синхронно переводит в ready
      if (editor.phase === 'ready') {
        goToMode('edit');
        return;
      }
      beginPan(scr.x, scr.y, e.pointerId); // промах по стрелке → пан
      break;
    default:
      beginPan(scr.x, scr.y, e.pointerId);
  }
  updateUI();
}

/** Классификация касания в гонке: рядом с кандидатом — прицел/ход, иначе пан. */
function handleRaceDown(e: PointerEvent, scr: Vec, touch: boolean): void {
  const near = nearestCandScreen(scr);
  if (!near || near.dist > AIM_ZONE_PX) {
    beginPan(scr.x, scr.y, e.pointerId);
    return;
  }
  if (touch) {
    gesture = { kind: 'aim' };
    activeId = e.pointerId;
    aimAt(e);
  } else {
    hover = near.cand;
    gesture = { kind: 'move', cand: near.cand, downX: scr.x, downY: scr.y };
    activeId = e.pointerId;
  }
}

/** Драг одиночного жеста: финиш/ход при уходе за порог превращаются в пан. */
function handleGestureMove(e: PointerEvent, scr: Vec): void {
  const g = gesture;
  if (!g) return;
  switch (g.kind) {
    case 'draw':
    case 'edge':
      pointerMove(editor, vp.toWorld(e, drawLift(e)));
      break;
    case 'finish':
      if (Math.hypot(scr.x - g.downX, scr.y - g.downY) > DRAG_PX) {
        pointerCancel(editor); // незакоммиченный финиш отменяем
        beginPan(g.downX, g.downY, activeId!);
        movePan(scr);
      } else {
        pointerMove(editor, vp.toWorld(e, drawLift(e))); // обновляем превью финиша
      }
      break;
    case 'move':
      if (Math.hypot(scr.x - g.downX, scr.y - g.downY) > DRAG_PX) {
        beginPan(g.downX, g.downY, activeId!);
        movePan(scr);
      }
      break;
    case 'aim':
      aimAt(e);
      break;
    case 'pan':
      movePan(scr);
      break;
  }
}

/** Завершение одиночного жеста на pointerup. */
function endGesture(e: PointerEvent): void {
  const g = gesture;
  switch (g?.kind) {
    case 'draw':
    case 'edge':
    case 'finish': {
      const prevPhase = editor.phase;
      pointerMove(editor, vp.toWorld(e, drawLift(e)));
      pointerUp(editor);
      // Осевая замкнута (center → adjust) — «автор закончил рисовать»: вписываем.
      if (prevPhase === 'center' && editor.phase === 'adjust') vp.fitToContent();
      updateUI();
      break;
    }
    case 'move':
      commitMove(g.cand);
      break;
    case 'aim':
      // Отпускание: выбрать кандидата (превью + плавающая кнопка «Газу!»).
      loupe = null;
      hover = null;
      selected = findCandidate(vp.toWorld(e, aimLift()), touchTol());
      showConfirmMove(!!selected);
      break;
    case 'pan':
      break;
  }
  gesture = null;
  activeId = null;
  canvas.classList.remove('grabbing');
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  // setPointerCapture кидает NotFoundError для уже неактивного указателя.
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {}
  const touch = e.pointerType === 'touch';
  const scr = vp.toScreen(e);
  if (touch) activePointers.set(e.pointerId, scr);

  // Второй палец — пинч (зум + пан) во всех режимах.
  if (touch && activePointers.size === 2) {
    startPinch();
    redraw();
    return;
  }
  // Уже идёт пинч или уже есть активный указатель — новый игнорируем.
  if (pinch || activeId !== null) return;

  if (mode === 'edit') handleEditDown(e, scr, touch);
  else if (game && game.phase === 'race') handleRaceDown(e, scr, touch);
  redraw();
});

canvas.addEventListener('pointermove', (e) => {
  const touch = e.pointerType === 'touch';
  const scr = vp.toScreen(e);
  if (touch && activePointers.has(e.pointerId)) activePointers.set(e.pointerId, scr);

  if (pinch && activePointers.size >= 2) {
    updatePinch();
    redraw();
    return;
  }
  if (activeId !== null) {
    if (e.pointerId !== activeId) return;
    handleGestureMove(e, scr);
    redraw();
    return;
  }
  // Нет активного жеста: только hover мышью по кандидатам в гонке.
  if (!touch && mode === 'race' && game && game.phase === 'race') {
    const c = findCandidate(vp.toWorld(e));
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
    // Меньше двух пальцев — выходим из пинча. Палец, завершивший пинч, ход/финиш
    // НЕ выбирает (одиночный жест не начинается).
    if (activePointers.size < 2) pinch = null;
    redraw();
    return;
  }
  if (activeId === null || e.pointerId !== activeId) {
    redraw();
    return;
  }
  endGesture(e);
  redraw();
});

canvas.addEventListener('pointercancel', (e) => {
  const touch = e.pointerType === 'touch';
  if (touch) activePointers.delete(e.pointerId);
  if (pinch) {
    if (activePointers.size < 2) pinch = null;
    redraw();
    return;
  }
  if (activeId === null || e.pointerId !== activeId) return;
  const g = gesture;
  if (g && (g.kind === 'draw' || g.kind === 'edge' || g.kind === 'finish'))
    pointerCancel(editor);
  gesture = null;
  activeId = null;
  loupe = null;
  hover = null;
  selected = null;
  showConfirmMove(false);
  canvas.classList.remove('grabbing');
  redraw();
});

// Зум колесом мыши — относительно курсора.
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    vp.zoomAt(Math.pow(WHEEL_FACTOR, -e.deltaY), e.offsetX, e.offsetY);
    redraw();
  },
  { passive: false },
);

/** Зум кнопкой ＋/－ (десктоп) — относительно центра поля. */
function zoomByButton(dir: 1 | -1): void {
  const { w, h } = vp.viewSize();
  vp.zoomAt(dir > 0 ? ZOOM_BTN_FACTOR : 1 / ZOOM_BTN_FACTOR, w / 2, h / 2);
  redraw();
}
document.getElementById('zoomIn')?.addEventListener('click', () => zoomByButton(1));
document.getElementById('zoomOut')?.addEventListener('click', () => zoomByButton(-1));

/**
 * Перейти к шагу выбора режима игры. Из редактора («edit») сначала финализируем
 * нарисованную трассу; если не удалось — показываем ошибку и остаёмся в редакторе.
 * Из гонки («race», «та же трасса») берём готовую трассу текущей гонки. Если онлайн
 * не настроен — сразу к выбору числа игроков (только локальная игра).
 */
function goToMode(from: 'edit' | 'race'): void {
  if (from === 'edit') {
    const res = finalizeTrack(
      editor.outer!,
      editor.inner!,
      editor.finish!,
      editor.forward!,
    );
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
  mode = onlineAvailable() ? 'mode' : 'players';
  updateUI();
  redraw();
}

/** Назад из шага настройки (режим/игроки): в редактор или к текущей гонке. */
function backFromSetup(): void {
  if (playersReturn === 'race') {
    mode = 'race';
  } else {
    mode = 'edit';
    stepBack(editor); // ready → direction
  }
  raceTrack = null;
  updateUI();
  redraw();
}

/** Выбрано число игроков — стартуем локальную гонку на подготовленной трассе. */
function startRace(playerCount: number): void {
  if (!raceTrack) return;
  game = newGame(raceTrack, playerCount);
  mode = 'race';
  vp.fitToContent();
  refreshCands();
  updateUI();
  redraw();
}

/** Сбросить всё к чистому редактору (новая трасса / выход из онлайна). */
function resetToEdit(): void {
  game = null;
  raceTrack = null;
  cands = null;
  hover = null;
  selected = null;
  showConfirmMove(false);
  editor = newEditor();
  mode = 'edit';
  // Пустое поле → resize() покажет дефолтный вид (границ содержимого нет).
  updateUI();
  resize();
}

// ── Онлайн-режим ────────────────────────────────────────────────────────────────

function savedName(): string {
  return localStorage.getItem('pr-player-name') ?? '';
}
function rememberName(n: string): void {
  localStorage.setItem('pr-player-name', n);
}

/** Разложить ошибку присоединения в понятный текст. */
function joinErrorText(e: unknown): string {
  const m = (e as { message?: string })?.message ?? '';
  if (m.includes('game_not_found')) return strings.online.notFound;
  if (m.includes('game_full')) return strings.online.full;
  if (m.includes('game_started')) return strings.online.started;
  return strings.online.error;
}

/** Перерисовать панель лобби по текущему ростеру сессии. */
function renderLobbyPanel(): void {
  const roster = session.getRoster();
  const mine = session.mySeat();
  renderLobby({
    code: session.getCode() ?? '',
    players: roster.map((r, i) => ({
      name: r.name,
      color: seatColor(i),
      you: i === mine,
    })),
    canStart: session.canStart(),
    isHost: session.isHost(),
  });
}

const onlineHandlers: OnlineHandlers = {
  onLobby: () => {
    if (mode === 'lobby') renderLobbyPanel();
  },
  onGameState: (g) => {
    game = g;
    if (mode !== 'race') {
      mode = 'race';
      closeOverlay();
      vp.fitToContent();
    }
    refreshCands();
    updateUI();
    redraw();
  },
  onClosed: () => {
    showToast(strings.online.closed);
    resetToEdit();
  },
};

/** Создать онлайн-игру (хост) с введённым именем и открыть лобби. */
async function hostOnline(name: string): Promise<void> {
  if (!raceTrack) return;
  try {
    await session.host(raceTrack, name, onlineHandlers);
    mode = 'lobby';
    updateUI();
    renderLobbyPanel();
    redraw();
  } catch {
    showToast(strings.online.error);
  }
}

/**
 * Присоединиться к онлайн-игре по коду. inJoinDialog — ошибку показываем прямо в
 * диалоге входа (он остаётся открыт); иначе (вход по ссылке) — тостом.
 */
async function joinOnline(
  code: string,
  name: string,
  inJoinDialog: boolean,
): Promise<void> {
  try {
    await session.join(code, name, onlineHandlers);
    closeOverlay();
    const t = session.getTrack();
    if (t) {
      editor = editorFromTrack(t); // превью трассы хоста в лобби
      raceTrack = null; // гость не владеет трассой
    }
    // Реконнект в уже идущую гонку: onGameState уже перевёл в режим race —
    // не сбрасываем обратно в лобби. Иначе (игра ещё не начата) — в лобби.
    if (mode !== 'race') mode = 'lobby';
    vp.fitToContent(); // вписать трассу хоста по центру
    redraw();
    updateUI();
    if (mode === 'lobby') renderLobbyPanel();
  } catch (e) {
    if (inJoinDialog) showJoinError(joinErrorText(e));
    else showToast(joinErrorText(e));
  }
}

/** Хост стартует онлайн-гонку: строит стейт с именами игроков и рассылает его. */
async function startOnline(): Promise<void> {
  if (!raceTrack || !session.canStart()) return;
  const roster = session.getRoster();
  const g = newGame(raceTrack, roster.length);
  roster.forEach((r, i) => {
    if (g.players[i]) g.players[i].name = r.name;
  });
  game = g;
  mode = 'race';
  vp.fitToContent();
  refreshCands();
  updateUI();
  redraw();
  try {
    await session.start(g);
  } catch {
    showToast(strings.online.error);
  }
}

/** Выйти из лобби: освободить место на сервере и вернуться (хост — к выбору режима). */
async function leaveLobby(): Promise<void> {
  const wasHost = raceTrack !== null;
  await session.leave();
  if (wasHost) {
    mode = 'mode';
    updateUI();
    redraw();
  } else {
    resetToEdit();
  }
}

/** Поделиться ссылкой на игру (Web Share или копирование в буфер). */
async function shareLink(): Promise<void> {
  const code = session.getCode();
  if (!code) return;
  const url = `${location.origin}${import.meta.env.BASE_URL}?join=${code}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: strings.app.title, url });
    } catch {
      // Пользователь отменил шаринг — ничего не делаем.
    }
  } else {
    try {
      await navigator.clipboard.writeText(url);
      showToast(strings.online.copied);
    } catch {
      showToast(url);
    }
  }
}

/** Скопировать код игры в буфер. */
async function copyCode(): Promise<void> {
  const code = session.getCode();
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    showToast(strings.online.codeCopied);
  } catch {
    // Буфер недоступен — код и так виден на экране.
  }
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
    if (selected) commitMove(selected);
  },
  onChooseSameTrack: () => goToMode('race'),
  onPlayersBack: () => {
    // С экрана числа игроков назад — к выбору режима (если онлайн доступен) или
    // сразу в редактор/гонку (когда режимного шага не было).
    if (onlineAvailable()) {
      mode = 'mode';
      updateUI();
      redraw();
    } else {
      backFromSetup();
    }
  },
  onPlayerCount: (n) => startRace(n),
  onNewTrack: () => resetToEdit(),
  onModeLocal: () => {
    mode = 'players';
    updateUI();
    redraw();
  },
  onModeOnline: () => {
    openNameDialog(strings.online.create, savedName(), (name) => {
      rememberName(name);
      hostOnline(name);
    });
  },
  onModeBack: () => backFromSetup(),
  onJoinByCode: () => {
    openJoinDialog(savedName(), '', (code, name) => {
      rememberName(name);
      joinOnline(code, name, true);
    });
  },
  onLobbyStart: () => startOnline(),
  onLobbyShare: () => shareLink(),
  onLobbyCopyCode: () => copyCode(),
  onLobbyLeave: () => leaveLobby(),
});

// Заполнить статичные тексты разметки из strings до первого показа панели.
localizeDom();

// Онлайн-входы показываем только если бэкенд настроен (иначе — только локальная игра).
setOnlineEnabled(onlineAvailable());

// Камера: связать вьюпорт с canvas/обёрткой и провайдером границ содержимого.
vp.initViewport(canvas, wrap, contentBounds);

// ResizeObserver вместо window.resize: обёртка меняет размер и при смене
// раскладки (портрет/ландшафт на мобильных), а не только окна.
new ResizeObserver(resize).observe(wrap);
updateUI();
resize();

// Открыта ссылка-приглашение (?join=CODE) — спросить имя и подключиться к игре.
const joinParam = new URLSearchParams(location.search).get('join');
if (joinParam && onlineAvailable()) {
  openNameDialog(strings.online.joinSubmit, savedName(), (name) => {
    rememberName(name);
    joinOnline(joinParam.toUpperCase(), name, false);
  });
}

// Предложить установить игру ярлыком на телефон (Android/Chromium и iOS Safari).
initInstallPrompt();
