// Оркестрация: события мыши на canvas, переключение фаз редактор/гонка.

import './styles/index.css';
import { Vec, dist } from './geometry';
import { Track, WORLD_W, WORLD_H, finalizeTrack, setWorldSize } from './track';
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
let pinch: {
  d0: number;
  midX: number;
  midY: number;
  zoom0: number;
  panX0: number;
  panY0: number;
} | null = null;

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

/** Показывать ли лупу при прицеливании: пока клетки мелкие. При достаточном
 *  зуме точки и так легко тапнуть — лупа не нужна. */
function loupeActive(): boolean {
  return effCell() < LOUPE_MAX_CELL_PX;
}

/** Подъём точки прицела над пальцем — только когда есть лупа (иначе палец
 *  закрыл бы точку). Без лупы пользователь тапает ровно в точку, лифт = 0. */
function aimLift(): number {
  return loupeActive() ? TOUCH_LIFT : 0;
}

/** Прицеливание пальцем: подсветить ближайшего кандидата и (если нужна) лупу. */
function aimAt(e: PointerEvent): void {
  hover = findCandidate(toWorld(e, aimLift()), touchTol());
  loupe = loupeActive() ? aimScreen(e) : null;
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
    if (editor.phase === 'ready') {
      goToMode('edit');
      return;
    }
    updateUI();
  } else if (game && game.phase === 'race') {
    if (touch) {
      aimAt(e);
    } else {
      const c = findCandidate(w);
      if (c) commitMove(c);
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
    selected = findCandidate(toWorld(e, aimLift()), touchTol());
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
  resetView();
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
  worldLocked = false; // новая трасса берёт пропорции под текущую ориентацию
  mode = 'edit';
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
      resetView();
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
      worldLocked = true; // размеры мира взяты у хоста — не пересчитывать
    }
    mode = 'lobby';
    resize(); // подогнать сетку под мир хоста + redraw
    updateUI();
    renderLobbyPanel();
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
  resetView();
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
