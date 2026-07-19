// Ввод: жесты указателя на canvas (рисование осевой, тюнинг кромки, финиш,
// прицел в гонке, пан, пинч) и зум (колесо/кнопки ＋－). Вынесено из main.ts.
// Модуль владеет только состоянием ввода (текущий жест, активные указатели,
// пинч) и производной визуальной подсветкой (hover/selected/loupe), которую
// читает рендер; игровое состояние (mode/editor/game/cands) он читает и правит
// через переданный на init InputDeps. Ровно один набор обработчиков на приложение.

import { Vec, dist } from '../geometry';
import { pointerDown, pointerMove, pointerUp, pointerCancel } from '../model/editor';
import { Candidate } from '../model/game';
import { AppState } from '../app-state';
import { worldToScreen, screenToWorld, clampScale } from './camera';
import * as vp from './viewport';
import { showConfirmMove } from '../ui/panel';
import {
  TOUCH_LIFT,
  TOUCH_TOL_PX,
  LOUPE_MAX_CELL_PX,
  AIM_ZONE_PX,
  CONFIRM_BTN_ZONE_PX,
  DRAG_PX,
  ZOOM_BTN_FACTOR,
  WHEEL_FACTOR,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP_PX,
  DOUBLE_TAP_DRAG_PX_PER_2X,
} from '../config';

/**
 * Мост к главному модулю: ввод не держит игровое состояние сам. Читает его по
 * ссылке через `state` (`state.mode`, `state.editor`, `state.game`, `state.cands`);
 * применяет ходы и намётки через колбэки.
 */
export interface InputDeps {
  canvas: HTMLCanvasElement;
  /** Единое состояние приложения (по ссылке, см. app-state.ts). */
  state: AppState;
  /** Применить выбранный ход (мышь-клик или подтверждение тача). */
  commitMove(cand: Candidate): void;
  /** Сейчас не мой ход, но своё место может наметить ход заранее (онлайн/vs-боты). */
  isPreselect(): boolean;
  /** Наметить ход (предвыбор в чужую очередь) — вместо коммита/выбора-под-кнопку. */
  setPending(cand: Candidate): void;
  /** Перейти к настройке гонки из редактора (тап по стрелке направления). */
  goToMode(from: 'edit' | 'race'): void;
  updateUI(): void;
  redraw(): void;
}

let deps: InputDeps;
let canvas: HTMLCanvasElement;

// ── Визуальная подсветка, которую читает рендер ─────────────────────────────
let hover: Candidate | null = null;
/** Последняя экранная позиция курсора мыши (css-px) — чтобы пересобрать hover после
 *  пересчёта кандидатов (в чужой ход бот/соперник ходит, пока курсор стоит на точке;
 *  без этого наведение мигало бы). Только мышь; на тач-устройстве остаётся null. */
let lastMouseScreen: Vec | null = null;
/** Тач: кандидат, выбранный первым касанием и ждущий подтверждения. */
let selected: Candidate | null = null;
/** Тач: позиция пальца (css-px canvas) во время прицеливания — включает лупу. */
let loupe: Vec | null = null;

export function getHover(): Candidate | null {
  return hover;
}
export function getSelected(): Candidate | null {
  return selected;
}
export function getLoupe(): Vec | null {
  return loupe;
}

/**
 * Пересобрать наведение мышью по последней позиции курсора после пересчёта кандидатов.
 * Нужно в чужой ход (предвыбор): входящий стейт (ход бота/соперника) обновляет cands,
 * но курсор стоит на месте — без этого hover бы гас на каждом чужом ходе. Пересчёт от
 * экранной позиции корректен и после пана/зума. Тач сюда не попадает (lastMouseScreen
 * не задаётся касанием). Перерисовку делает вызывающий (refreshCands → redraw).
 */
export function reaimHover(): void {
  if (lastMouseScreen === null) return;
  const game = deps.state.game;
  if (deps.state.mode !== 'race' || !game || game.phase !== 'race') return;
  hover = findCandidate(screenToWorld(vp.camera(), lastMouseScreen));
}

/** Сбросить подсветку/выбор (при пересчёте кандидатов и сбросе к редактору). */
export function clearSelection(): void {
  hover = null;
  selected = null;
  loupe = null;
  showConfirmMove(false);
}

// ── Состояние жестов ─────────────────────────────────────────────────────────
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
  | { kind: 'dtap'; downX: number; downY: number; scale0: number } // второй тач двойного тапа: в покое → ничего, драг вниз/вверх → плавный зум
  | { kind: 'pan'; ox0: number; oy0: number; sx0: number; sy0: number };
let gesture: Gesture | null = null;
let activeId: number | null = null;

// ── Двойной тап (тач) → зум камеры поля к точке ─────────────────────────────
// Свой жест вместо нативного iOS-зума (тот хайджекит пан/лупу). Помним последний
// «чистый» тап (без протяжки); следующий тап рядом и вовремя — двойной.
let lastTapT = 0;
let lastTapScr: Vec | null = null;
/** Начало текущего одиночного тач-жеста — чтобы отличить тап от протяжки на up. */
let tapDownT = 0;
let tapDownScr: Vec | null = null;

/** Радиус попадания по кандидату в клетках: для пальца — не меньше TOUCH_TOL_PX. */
function touchTol(): number {
  return Math.max(0.45, TOUCH_TOL_PX / vp.scale());
}

/** Нужен ли лифт точки над пальцем при прицеливании — пока клетки мелкие. */
function loupeActive(): boolean {
  return vp.scale() < LOUPE_MAX_CELL_PX;
}

/**
 * Смещение точки рисования вверх — только при freehand-рисовании края пальцем.
 * Протяжка финиша и тап по стрелкам остаются точно под пальцем (лифт = 0).
 */
function drawLift(e: PointerEvent): number {
  const editor = deps.state.editor;
  return e.pointerType === 'touch' &&
    deps.state.mode === 'edit' &&
    (editor.phase === 'center' || editor.phase === 'adjust')
    ? TOUCH_LIFT
    : 0;
}

/** Экранная точка прицела для тач-гонки: положение пальца, поднятое на TOUCH_LIFT. */
function aimScreen(e: PointerEvent): Vec {
  const s = vp.toScreen(e);
  return { x: s.x, y: s.y - TOUCH_LIFT };
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

function findCandidate(w: Vec, tol = 0.45): Candidate | null {
  const cands = deps.state.cands;
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

/**
 * Где показать кнопку подтверждения. По умолчанию внизу; уводим наверх, только
 * если нижний кандидат реально заходит в зону кнопки у нижнего края (иначе тап по
 * цели попадёт в кнопку — чужой ход). Просто «ниже центра» не считается, чтобы
 * кнопка не прыгала туда-сюда попусту.
 */
function confirmAnchor(): 'top' | 'bottom' {
  const cands = deps.state.cands;
  const view = vp.camera();
  const { h } = vp.viewSize();
  let maxY = -Infinity; // экранный Y самого нижнего незаблокированного кандидата
  if (cands)
    for (const c of cands) {
      if (c.blocked) continue;
      maxY = Math.max(maxY, worldToScreen(view, c.target).y);
    }
  return maxY > h - CONFIRM_BTN_ZONE_PX ? 'top' : 'bottom';
}

/** Ближайший (незаблокированный) кандидат к экранной точке, в css-px. */
function nearestCandScreen(scr: Vec): { cand: Candidate; dist: number } | null {
  const cands = deps.state.cands;
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
  // Выбранного кандидата и кнопку «Газу!» пан НЕ сбрасывает: превью рисуется в
  // мировых координатах и едет с картой, а кнопку (фикс. оверлей) переякорим на
  // отпускании (endGesture). Так пан по полю не заставляет выбирать ход заново.
  canvas.classList.add('grabbing');
}

/** Только в гонке (racing/финал): двойной тап зумит поле, а не рисует. */
function doubleTapEnabled(): boolean {
  return deps.state.mode === 'race';
}

/** Этот тач-даун — второй тап двойного тапа (рядом и вовремя с прошлым)? */
function isDoubleTapDown(scr: Vec): boolean {
  return (
    doubleTapEnabled() &&
    lastTapScr !== null &&
    performance.now() - lastTapT < DOUBLE_TAP_MS &&
    dist(scr, lastTapScr) < DOUBLE_TAP_SLOP_PX
  );
}

/** Запомнить «чистый» тап (up без протяжки) — кандидат на первый тап двойного. */
function recordTap(upScr: Vec): void {
  if (
    tapDownScr &&
    performance.now() - tapDownT < DOUBLE_TAP_MS &&
    dist(upScr, tapDownScr) < DRAG_PX
  ) {
    lastTapT = performance.now();
    lastTapScr = upScr;
  }
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
  const editor = deps.state.editor;
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
        deps.goToMode('edit');
        return;
      }
      beginPan(scr.x, scr.y, e.pointerId); // промах по стрелке → пан
      break;
    default:
      beginPan(scr.x, scr.y, e.pointerId);
  }
  deps.updateUI();
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
      pointerMove(deps.state.editor, vp.toWorld(e, drawLift(e)));
      break;
    case 'finish':
      if (Math.hypot(scr.x - g.downX, scr.y - g.downY) > DRAG_PX) {
        pointerCancel(deps.state.editor); // незакоммиченный финиш отменяем
        beginPan(g.downX, g.downY, activeId!);
        movePan(scr);
      } else {
        pointerMove(deps.state.editor, vp.toWorld(e, drawLift(e))); // обновляем превью финиша
      }
      break;
    case 'move':
      // Протяжка мыши-хода — это пан, не коммит: так пан/лупа не хайджекятся.
      if (Math.hypot(scr.x - g.downX, scr.y - g.downY) > DRAG_PX) {
        beginPan(g.downX, g.downY, activeId!);
        movePan(scr);
      }
      break;
    case 'dtap': {
      // Двойной тап + тяни: непрерывный зум к точке первого касания (как в картах).
      // Вниз (dy > 0) приближает, вверх — отдаляет; масштаб абсолютный от scale0.
      const dy = scr.y - g.downY;
      const target = clampScale(g.scale0 * 2 ** (dy / DOUBLE_TAP_DRAG_PX_PER_2X));
      vp.zoomAt(target / vp.scale(), g.downX, g.downY); // redraw делает вызывающий
      break;
    }
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
  const touch = e.pointerType === 'touch';
  const upScr = vp.toScreen(e);
  switch (g?.kind) {
    // 'dtap' зумит вживую на move; на отпускании делать нечего.
    case 'draw':
    case 'edge':
    case 'finish': {
      const editor = deps.state.editor;
      const prevPhase = editor.phase;
      pointerMove(editor, vp.toWorld(e, drawLift(e)));
      pointerUp(editor);
      // Осевая замкнута (center → adjust) — «автор закончил рисовать»: вписываем.
      if (prevPhase === 'center' && editor.phase === 'adjust') vp.fitToContent();
      deps.updateUI();
      break;
    }
    case 'move':
      // Десктоп-клик: в чужой ход — наметка, в свой — коммит.
      if (deps.isPreselect()) deps.setPending(g.cand);
      else deps.commitMove(g.cand);
      break;
    case 'aim': {
      // Отпускание: выбрать кандидата. В свой ход — превью + плавающая кнопка «Газу!»;
      // в чужой ход (предвыбор) — наметка (кнопку не показываем, ждём своей очереди).
      loupe = null;
      hover = null;
      const cand = findCandidate(vp.toWorld(e, aimLift()), touchTol());
      if (deps.isPreselect()) {
        if (cand) deps.setPending(cand);
      } else {
        selected = cand;
        showConfirmMove(!!selected, confirmAnchor());
      }
      break;
    }
    case 'pan':
      // Пан сохраняет выбор: переякорим кнопку «Газу!» — после сдвига карты
      // нижний кандидат мог заехать в зону кнопки (confirmAnchor это учтёт).
      if (selected) showConfirmMove(true, confirmAnchor());
      break;
  }
  // Тач-тап без протяжки (кроме самого зума) — кандидат на первый тап двойного.
  if (touch && g?.kind !== 'dtap') recordTap(upScr);
  gesture = null;
  activeId = null;
  canvas.classList.remove('grabbing');
}

/** Зум кнопкой ＋/－ (десктоп) — относительно центра поля. */
function zoomByButton(dir: 1 | -1): void {
  const { w, h } = vp.viewSize();
  vp.zoomAt(dir > 0 ? ZOOM_BTN_FACTOR : 1 / ZOOM_BTN_FACTOR, w / 2, h / 2);
  deps.redraw();
}

/** Подключить все обработчики ввода к canvas и кнопкам зума. */
export function initInput(d: InputDeps): void {
  deps = d;
  canvas = d.canvas;

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
      deps.redraw();
      return;
    }
    // Уже идёт пинч или уже есть активный указатель — новый игнорируем.
    if (pinch || activeId !== null) return;

    // Начало одиночного тач-жеста: запоминаем точку/время для детекта тапа на up.
    if (touch) {
      tapDownScr = scr;
      tapDownT = performance.now();
    }
    // Второй тап рядом и вовремя — свой зум камеры (а не рисование/прицел). Протяжка
    // этого тапа вниз/вверх плавно зумит (handleGestureMove), так что лупа не хайджекится.
    if (touch && isDoubleTapDown(scr)) {
      lastTapScr = null; // погасить, чтобы третий тап не зумил повторно
      loupe = null;
      hover = null;
      selected = null;
      showConfirmMove(false);
      gesture = { kind: 'dtap', downX: scr.x, downY: scr.y, scale0: vp.scale() };
      activeId = e.pointerId;
      deps.redraw();
      return;
    }

    const game = deps.state.game;
    if (deps.state.mode === 'edit') handleEditDown(e, scr, touch);
    else if (game && game.phase === 'race') handleRaceDown(e, scr, touch);
    // Гонка окончена (game.phase !== 'race') — прицеливаться уже не по чему,
    // остаётся только пан по финальной карте.
    else if (game) beginPan(scr.x, scr.y, e.pointerId);
    deps.redraw();
  });

  canvas.addEventListener('pointermove', (e) => {
    const touch = e.pointerType === 'touch';
    const scr = vp.toScreen(e);
    if (touch && activePointers.has(e.pointerId)) activePointers.set(e.pointerId, scr);
    // Позиция курсора мыши — для пересборки hover после чужого хода (reaimHover).
    if (!touch) lastMouseScreen = scr;

    if (pinch && activePointers.size >= 2) {
      updatePinch();
      deps.redraw();
      return;
    }
    if (activeId !== null) {
      if (e.pointerId !== activeId) return;
      handleGestureMove(e, scr);
      deps.redraw();
      return;
    }
    // Нет активного жеста: только hover мышью по кандидатам в гонке.
    const game = deps.state.game;
    if (!touch && deps.state.mode === 'race' && game && game.phase === 'race') {
      const c = findCandidate(vp.toWorld(e));
      if (c !== hover) {
        hover = c;
        deps.redraw();
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
      deps.redraw();
      return;
    }
    if (activeId === null || e.pointerId !== activeId) {
      deps.redraw();
      return;
    }
    endGesture(e);
    deps.redraw();
  });

  canvas.addEventListener('pointercancel', (e) => {
    const touch = e.pointerType === 'touch';
    if (touch) activePointers.delete(e.pointerId);
    if (pinch) {
      if (activePointers.size < 2) pinch = null;
      deps.redraw();
      return;
    }
    if (activeId === null || e.pointerId !== activeId) return;
    const g = gesture;
    if (g && (g.kind === 'draw' || g.kind === 'edge' || g.kind === 'finish')) {
      pointerCancel(deps.state.editor);
      deps.updateUI();
    }
    gesture = null;
    activeId = null;
    loupe = null;
    hover = null;
    selected = null;
    showConfirmMove(false);
    canvas.classList.remove('grabbing');
    deps.redraw();
  });

  // Курсор ушёл с поля: гасим наведение и забываем позицию, чтобы reaimHover не
  // воскрешал hover на чужом ходе, когда мыши над полем уже нет. Во время жеста
  // (указатель захвачен) это событие не приходит — там hover ведёт сам жест.
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch' || activeId !== null) return;
    lastMouseScreen = null;
    if (hover) {
      hover = null;
      deps.redraw();
    }
  });

  // Зум колесом мыши — относительно курсора.
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      vp.zoomAt(Math.pow(WHEEL_FACTOR, -e.deltaY), e.offsetX, e.offsetY);
      deps.redraw();
    },
    { passive: false },
  );

  // iOS Safari игнорирует `user-scalable=no`, а `touch-action:none` глушит зум не
  // всегда (double-tap-drag/page-pinch протекают и хайджекят пан/лупу). Глушим
  // нативные жест-события напрямую: свой зум даём двойным тапом и пинчем. `dblclick`
  // — страховка от double-tap-зума. Пассивно нельзя (нужен preventDefault).
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  canvas.addEventListener('dblclick', (e) => e.preventDefault());

  document.getElementById('zoomIn')?.addEventListener('click', () => zoomByButton(1));
  document.getElementById('zoomOut')?.addEventListener('click', () => zoomByButton(-1));

  // Страховка: если кнопка подтверждения всё же накрыла кандидата, касание пальцем
  // по такой скрытой точке перехватываем в прицеливание, а не в подтверждение —
  // иначе подтвердится ранее выбранный (чужой) ход. Обычный тап по кнопке (рядом
  // кандидата нет) проходит как есть и коммитит.
  // Контракт с `ui/dom.ts` (bindTap): коммит завязан на приход `pointerup` на кнопку.
  // `setPointerCapture` ниже забирает указатель на canvas — тогда `pointerup` до кнопки
  // не долетает и bindTap не коммитит. Не менять на перехват по `pointerup`/добавление
  // capture на саму кнопку — сломает это разделение «прицел vs коммит».
  document.getElementById('confirmMove')?.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || pinch || activeId !== null) return;
    const game = deps.state.game;
    if (!(deps.state.mode === 'race' && game && game.phase === 'race')) return;
    const scr = vp.toScreen(e);
    const near = nearestCandScreen(scr);
    if (!near || near.dist > AIM_ZONE_PX) return; // рядом нет цели — пусть коммитит
    e.preventDefault();
    e.stopPropagation();
    try {
      canvas.setPointerCapture(e.pointerId); // забираем указатель у кнопки на canvas
    } catch {}
    activePointers.set(e.pointerId, scr);
    gesture = { kind: 'aim' };
    activeId = e.pointerId;
    aimAt(e);
    deps.redraw();
  });
}
