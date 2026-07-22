// Input: pointer gestures on the canvas (drawing the centerline, edge tuning,
// finish line, aiming during the race, panning, pinch) and zoom (wheel/±
// buttons). Extracted out of main.ts.
// The module owns only input state (current gesture, active pointers, pinch)
// and derived visual highlighting (hover/selected/loupe) that render reads;
// game state (mode/editor/game/cands) is read and mutated through the
// InputDeps passed in at init. Exactly one set of handlers per app instance.

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
 * Bridge to the main module: input doesn't hold game state itself. It reads
 * it by reference through `state` (`state.phase`, `state.editor`,
 * `state.game`, `state.cands`) and applies moves/pending picks via callbacks.
 */
export interface InputDeps {
  canvas: HTMLCanvasElement;
  /** Single shared app state (by reference, see app-state.ts). */
  state: AppState;
  /** Apply the chosen move (mouse click or touch confirmation). */
  commitMove(cand: Candidate): void;
  /** Not our turn right now, but we can pre-pick a move for later (online/vs bots). */
  isPreselect(): boolean;
  /** Pre-pick a move (queued for our next turn) instead of committing/highlighting the button. */
  setPending(cand: Candidate): void;
  /** Leave the editor and go to race setup (tap on the direction arrow). */
  goToMode(from: 'edit' | 'race'): void;
  updateUI(): void;
  redraw(): void;
}

let deps: InputDeps;
let canvas: HTMLCanvasElement;

// ── Visual highlighting that render reads ───────────────────────────────────
let hover: Candidate | null = null;
/** Last mouse cursor screen position (css px) — used to rebuild hover after
 *  candidates are recomputed (a bot/opponent moves on their turn while the
 *  cursor sits still; without this the hover would flicker). Mouse only; stays
 *  null on touch devices. */
let lastMouseScreen: Vec | null = null;
/** Touch: candidate picked by the first tap, awaiting confirmation. */
let selected: Candidate | null = null;
/** Touch: finger position (canvas css px) while aiming — drives the loupe. */
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
 * Rebuild mouse hover from the last cursor position after candidates change.
 * Needed on the opponent's turn (pre-pick mode): incoming state (a bot/
 * opponent move) updates cands while the cursor stays put — without this the
 * hover would go stale on every opponent move. Recomputing from the screen
 * position stays correct across pan/zoom too. Touch never hits this path
 * (lastMouseScreen is never set by touch). The caller (refreshCands →
 * redraw) triggers the actual redraw.
 */
export function reaimHover(): void {
  if (lastMouseScreen === null) return;
  const game = deps.state.game;
  if (deps.state.phase !== 'race' || !game || game.phase !== 'race') return;
  hover = findCandidate(screenToWorld(vp.camera(), lastMouseScreen));
}

/** Clear highlighting/selection (on candidate recompute and on reset to editor). */
export function clearSelection(): void {
  hover = null;
  selected = null;
  loupe = null;
  showConfirmMove(false);
}

// ── Gesture state ────────────────────────────────────────────────────────────
/** Active touch pointers (used to detect a two-finger pinch). */
const activePointers = new Map<number, Vec>();
/** Snapshot taken at the start of a pinch gesture; null when no pinch is active. */
let pinch: {
  d0: number;
  midX: number;
  midY: number;
  scale0: number;
  ox0: number;
  oy0: number;
} | null = null;

/**
 * Current single-pointer gesture. `activeId` is the id of the owning pointer
 * (a second finger diverts into a pinch; any others are ignored). Some
 * gestures (finish/move) turn into a pan once dragged far enough.
 */
type Gesture =
  | { kind: 'draw' } // drawing the centerline (center step)
  | { kind: 'edge' } // edge tuning (adjust step)
  | { kind: 'finish'; downX: number; downY: number } // tap-to-set finish line; drag → pan
  | { kind: 'aim' } // touch aiming during the race (loupe)
  | { kind: 'move'; cand: Candidate; downX: number; downY: number } // mouse move pick; drag → pan
  | { kind: 'dtap'; downX: number; downY: number; scale0: number } // second tap of a double-tap: idle → nothing, drag up/down → smooth zoom
  | { kind: 'pan'; ox0: number; oy0: number; sx0: number; sy0: number };
let gesture: Gesture | null = null;
let activeId: number | null = null;

/**
 * Full reset of input state back to a clean slate. This is a safety net
 * against "phantom" pointers: iOS Safari frequently DROPS the terminal
 * pointerup/pointercancel (hijacked by a system gesture, both fingers lifted
 * at once, app backgrounded) — the finger's record then lingers in
 * `activePointers` forever, and the next single touch is falsely read as a
 * pinch (`size === 2` because of the phantom) → the field zooms and the only
 * way out is a restart.
 */
function resetGestureState(): void {
  activePointers.clear();
  pinch = null;
  gesture = null;
  activeId = null;
  loupe = null;
  hover = null;
  selected = null;
  showConfirmMove(false);
  canvas.classList.remove('grabbing');
}

// ── Double-tap (touch) → zoom the field camera toward a point ──────────────
// Our own gesture instead of the native iOS zoom (which hijacks pan/loupe).
// We remember the last "clean" tap (no drag); a nearby tap soon after counts
// as a double-tap.
let lastTapT = 0;
let lastTapScr: Vec | null = null;
/** Start of the current single-touch gesture — used to tell a tap from a drag on up. */
let tapDownT = 0;
let tapDownScr: Vec | null = null;

/** Candidate hit radius in cells: for a finger, never smaller than TOUCH_TOL_PX. */
function touchTol(): number {
  return Math.max(0.45, TOUCH_TOL_PX / vp.scale());
}

/** Whether the aim point needs to be lifted above the finger — only while cells are small. */
function loupeActive(): boolean {
  return vp.scale() < LOUPE_MAX_CELL_PX;
}

/**
 * Upward offset for the drawing point — only while freehand-drawing an edge
 * with a finger. Dragging the finish line and tapping arrows stay exactly
 * under the finger (lift = 0).
 */
function drawLift(e: PointerEvent): number {
  const editor = deps.state.editor;
  return e.pointerType === 'touch' &&
    deps.state.phase === 'edit' &&
    (editor.step === 'center' || editor.step === 'adjust')
    ? TOUCH_LIFT
    : 0;
}

/** Screen aim point for touch racing: finger position lifted by TOUCH_LIFT. */
function aimScreen(e: PointerEvent): Vec {
  const s = vp.toScreen(e);
  return { x: s.x, y: s.y - TOUCH_LIFT };
}

/** Lift of the aim point above the finger — only while the loupe is shown
 *  (otherwise the finger would cover the point). Without the loupe the user
 *  taps exactly on the point, lift = 0. */
function aimLift(): number {
  return loupeActive() ? TOUCH_LIFT : 0;
}

/** Aiming with a finger: highlight the nearest candidate and show the loupe if needed. */
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

/** The two active touch pointers (for pinch). */
function pinchPoints(): [Vec, Vec] {
  const v = [...activePointers.values()];
  return [v[0], v[1]];
}

/** Start a pinch gesture from the current two fingers, aborting any single-pointer gesture. */
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

/** Recompute scale/pan from the two fingers: the world point under the gesture
 *  center stays under the center, and finger spacing drives the scale. */
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
 * Where to show the confirm button. Defaults to the bottom; only moves to the
 * top if the lowest candidate actually reaches into the button zone near the
 * bottom edge (otherwise a tap on the target would hit the button — wrong
 * move). Just "below center" doesn't count, so the button doesn't jump back
 * and forth for no reason.
 */
export function confirmAnchor(): 'top' | 'bottom' {
  const cands = deps.state.cands;
  const view = vp.camera();
  const { h } = vp.viewSize();
  let maxY = -Infinity; // screen Y of the lowest unblocked candidate
  if (cands)
    for (const c of cands) {
      if (c.blocked) continue;
      maxY = Math.max(maxY, worldToScreen(view, c.target).y);
    }
  return maxY > h - CONFIRM_BTN_ZONE_PX ? 'top' : 'bottom';
}

/** Nearest (unblocked) candidate to a screen point, in css px. */
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

/** Start a single-pointer map pan from a screen point. */
function beginPan(sx: number, sy: number, id: number): void {
  const c = vp.camera();
  gesture = { kind: 'pan', ox0: c.ox, oy0: c.oy, sx0: sx, sy0: sy };
  activeId = id;
  loupe = null;
  hover = null;
  // Panning does NOT clear the selected candidate or the "Go!" button: the
  // preview is drawn in world coordinates and travels with the map, and the
  // button (a fixed overlay) gets re-anchored on release (endGesture). So
  // panning the field never forces the player to pick a move again.
  canvas.classList.add('grabbing');
}

/**
 * Where a double-tap zooms the field (instead of drawing/aiming): during the
 * race (racing/finished) and in the track editor. In the editor, drawing is a
 * drag, and a double-tap is only recognized from two "clean" taps with no
 * drag in between, so a stroke never gets hijacked.
 */
function doubleTapEnabled(): boolean {
  return deps.state.phase === 'race' || deps.state.phase === 'edit';
}

/** Is this touch-down the second tap of a double-tap (close by and soon after the last one)? */
function isDoubleTapDown(scr: Vec): boolean {
  return (
    doubleTapEnabled() &&
    lastTapScr !== null &&
    performance.now() - lastTapT < DOUBLE_TAP_MS &&
    dist(scr, lastTapScr) < DOUBLE_TAP_SLOP_PX
  );
}

/** Remember a "clean" tap (up with no drag) as a candidate first tap of a double-tap. */
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

/** Move the camera to follow the pointer (pan gesture). */
function movePan(scr: Vec): void {
  if (gesture?.kind !== 'pan') return;
  vp.applyUserCamera({
    scale: vp.scale(),
    ox: gesture.ox0 + (scr.x - gesture.sx0),
    oy: gesture.oy0 + (scr.y - gesture.sy0),
  });
}

/** Classify a touch-down in the editor: drawing/edge-tuning/finish/arrow, or a pan. */
function handleEditDown(e: PointerEvent, scr: Vec, touch: boolean): void {
  const editor = deps.state.editor;
  const w = vp.toWorld(e, drawLift(e));
  const tol = touch ? Math.max(1.2, TOUCH_TOL_PX / vp.scale()) : 1.2;
  const step = editor.step;
  switch (step) {
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
      pointerDown(editor, w, tol); // sets dragStart + the finish-line preview
      gesture = { kind: 'finish', downX: scr.x, downY: scr.y };
      activeId = e.pointerId;
      break;
    case 'direction':
      pointerDown(editor, w, tol); // tapping the arrow immediately advances to ready
      if (editor.step === 'ready') {
        deps.goToMode('edit');
        return;
      }
      beginPan(scr.x, scr.y, e.pointerId); // missed the arrow → pan
      break;
    default:
      beginPan(scr.x, scr.y, e.pointerId);
  }
  deps.updateUI();
}

/** Classify a touch-down during the race: near a candidate → aim/move, otherwise pan. */
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

/** Drag handling for a single-pointer gesture: finish/move turn into a pan past the threshold. */
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
        pointerCancel(deps.state.editor); // cancel the uncommitted finish line
        beginPan(g.downX, g.downY, activeId!);
        movePan(scr);
      } else {
        pointerMove(deps.state.editor, vp.toWorld(e, drawLift(e))); // update the finish-line preview
      }
      break;
    case 'move':
      // Dragging a mouse move pick is a pan, not a commit: keeps pan/loupe from being hijacked.
      if (Math.hypot(scr.x - g.downX, scr.y - g.downY) > DRAG_PX) {
        beginPan(g.downX, g.downY, activeId!);
        movePan(scr);
      }
      break;
    case 'dtap': {
      // Double-tap + drag: continuous zoom toward the first tap's point (like map apps).
      // Down (dy > 0) zooms in, up zooms out; scale is absolute relative to scale0.
      const dy = scr.y - g.downY;
      const target = clampScale(g.scale0 * 2 ** (dy / DOUBLE_TAP_DRAG_PX_PER_2X));
      vp.zoomAt(target / vp.scale(), g.downX, g.downY); // caller triggers the redraw
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

/** Finish a single-pointer gesture on pointerup. */
function endGesture(e: PointerEvent): void {
  const g = gesture;
  const touch = e.pointerType === 'touch';
  const upScr = vp.toScreen(e);
  switch (g?.kind) {
    // 'dtap' zooms live on move; nothing to do on release.
    case 'draw':
    case 'edge':
    case 'finish': {
      const editor = deps.state.editor;
      const prevStep = editor.step;
      pointerMove(editor, vp.toWorld(e, drawLift(e)));
      pointerUp(editor);
      // Centerline just closed (center → adjust) — the author is done drawing: fit the view.
      if (prevStep === 'center' && editor.step === 'adjust') vp.fitToContent();
      deps.updateUI();
      break;
    }
    case 'move':
      // Desktop click: on the opponent's turn it's a pre-pick, on ours it's a commit.
      if (deps.isPreselect()) deps.setPending(g.cand);
      else deps.commitMove(g.cand);
      break;
    case 'aim': {
      // Release: pick the candidate. On our turn — preview + floating "Go!"
      // button; on the opponent's turn (pre-pick mode) — just queue it (no
      // button shown, we wait for our turn).
      loupe = null;
      hover = null;
      const cand = findCandidate(vp.toWorld(e, aimLift()), touchTol());
      if (deps.isPreselect()) {
        if (cand) deps.setPending(cand);
      } else {
        selected = cand;
        if (selected) deps.state.pending = null; // a fresh pick on our turn clears any queued move
        showConfirmMove(!!selected, confirmAnchor());
      }
      break;
    }
    case 'pan':
      // Panning keeps the selection: re-anchor the "Go!" button, since after
      // moving the map the lowest candidate may have entered the button zone
      // (confirmAnchor accounts for that).
      if (selected) showConfirmMove(true, confirmAnchor());
      break;
  }
  // A touch tap with no drag (other than the zoom gesture itself) is a candidate first tap of a double-tap.
  if (touch && g?.kind !== 'dtap') recordTap(upScr);
  gesture = null;
  activeId = null;
  canvas.classList.remove('grabbing');
}

/** Zoom via the +/- buttons (desktop) — relative to the field's center. */
function zoomByButton(dir: 1 | -1): void {
  const { w, h } = vp.viewSize();
  vp.zoomAt(dir > 0 ? ZOOM_BTN_FACTOR : 1 / ZOOM_BTN_FACTOR, w / 2, h / 2);
  deps.redraw();
}

/** Wire up all input handlers on the canvas and zoom buttons. */
export function initInput(d: InputDeps): void {
  deps = d;
  canvas = d.canvas;

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const touch = e.pointerType === 'touch';
    // The first finger of a new touch series (`isPrimary`) while state is
    // non-empty means a leftover phantom pointer from a dropped iOS
    // pointerup/pointercancel. In a healthy state `activePointers` would be
    // empty here — clear it, otherwise the phantom makes `size === 2` and a
    // single touch is falsely read as a pinch (field zooms until restart).
    if (touch && e.isPrimary && (activePointers.size > 0 || pinch || activeId !== null)) {
      resetGestureState();
    }
    // setPointerCapture throws NotFoundError for an already-inactive pointer.
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
    const scr = vp.toScreen(e);
    if (touch) activePointers.set(e.pointerId, scr);

    // A second finger means pinch (zoom + pan) in every mode.
    if (touch && activePointers.size === 2) {
      startPinch();
      deps.redraw();
      return;
    }
    // A pinch is already in progress, or a pointer is already active — ignore the new one.
    if (pinch || activeId !== null) return;

    // Start of a single-touch gesture: remember point/time to detect a tap on up.
    if (touch) {
      tapDownScr = scr;
      tapDownT = performance.now();
    }
    // A nearby, well-timed second tap means our own camera zoom (not
    // drawing/aiming). Dragging this tap up/down zooms smoothly
    // (handleGestureMove), so the loupe never gets hijacked.
    if (touch && isDoubleTapDown(scr)) {
      lastTapScr = null; // clear it so a third tap doesn't zoom again
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
    if (deps.state.phase === 'edit') handleEditDown(e, scr, touch);
    else if (game && game.phase === 'race') handleRaceDown(e, scr, touch);
    // Race is over (game.phase !== 'race') — nothing left to aim at, only
    // panning the final map remains.
    else if (game) beginPan(scr.x, scr.y, e.pointerId);
    deps.redraw();
  });

  canvas.addEventListener('pointermove', (e) => {
    const touch = e.pointerType === 'touch';
    const scr = vp.toScreen(e);
    if (touch && activePointers.has(e.pointerId)) activePointers.set(e.pointerId, scr);
    // Mouse cursor position — used to rebuild hover after the opponent's move (reaimHover).
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
    // No active gesture: only mouse hover over race candidates.
    const game = deps.state.game;
    if (!touch && deps.state.phase === 'race' && game && game.phase === 'race') {
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
      // Fewer than two fingers — exit the pinch. The finger that ended the
      // pinch does NOT pick a move/finish (no single-pointer gesture starts).
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
    resetGestureState();
    deps.redraw();
  });

  // Cursor left the field: clear hover and forget the position, so reaimHover
  // doesn't resurrect hover on the opponent's move once the mouse is no
  // longer over the field. This event doesn't fire during a gesture (pointer
  // is captured) — there the gesture itself drives hover.
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch' || activeId !== null) return;
    lastMouseScreen = null;
    if (hover) {
      hover = null;
      deps.redraw();
    }
  });

  // Mouse wheel zoom — relative to the cursor.
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      vp.zoomAt(Math.pow(WHEEL_FACTOR, -e.deltaY), e.offsetX, e.offsetY);
      deps.redraw();
    },
    { passive: false },
  );

  // iOS Safari ignores `user-scalable=no`, and `touch-action:none` doesn't
  // always suppress zoom (double-tap-drag/page-pinch leak through and hijack
  // pan/loupe). We suppress the native gesture events directly: our own zoom
  // comes from double-tap and pinch. `dblclick` is a safety net against
  // double-tap zoom. Can't be passive (needs preventDefault).
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  canvas.addEventListener('dblclick', (e) => e.preventDefault());

  // Backgrounding the app/losing focus can "swallow" the terminal pointerup
  // (iOS), leaving a phantom pointer behind. As a safety net, fully reset
  // gestures on tab hide and blur so we return to a clean state instead of a
  // stuck pinch-zoom.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) resetGestureState();
  });
  window.addEventListener('blur', () => resetGestureState());

  document.getElementById('zoomIn')?.addEventListener('click', () => zoomByButton(1));
  document.getElementById('zoomOut')?.addEventListener('click', () => zoomByButton(-1));

  // Safety net: if the confirm button ends up covering a candidate, a finger
  // tap on that hidden spot is redirected into aiming rather than
  // confirmation — otherwise it would confirm a previously selected (wrong)
  // move. A normal tap on the button (no candidate nearby) passes through as
  // usual and commits.
  // Contract with `ui/dom.ts` (bindTap): commit is tied to a `pointerup`
  // landing on the button. `setPointerCapture` below grabs the pointer onto
  // the canvas — then `pointerup` never reaches the button and bindTap
  // doesn't commit. Don't switch this to intercepting on `pointerup` or add
  // capture on the button itself — that would break the "aim vs commit" split.
  document.getElementById('confirmMove')?.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || pinch || activeId !== null) return;
    const game = deps.state.game;
    if (!(deps.state.phase === 'race' && game && game.phase === 'race')) return;
    const scr = vp.toScreen(e);
    const near = nearestCandScreen(scr);
    if (!near || near.dist > AIM_ZONE_PX) return; // no target nearby — let it commit
    e.preventDefault();
    e.stopPropagation();
    try {
      canvas.setPointerCapture(e.pointerId); // steal the pointer from the button onto the canvas
    } catch {}
    activePointers.set(e.pointerId, scr);
    gesture = { kind: 'aim' };
    activeId = e.pointerId;
    aimAt(e);
    deps.redraw();
  });
}
