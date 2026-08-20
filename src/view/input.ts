// Input: pointer gestures on the canvas (drawing the centerline, edge tuning,
// finish line, aiming during the race, panning, pinch) and zoom (wheel/±
// buttons). Extracted out of main.ts.
// The module owns only input state (current gesture, active pointers, pinch)
// and derived visual highlighting (hover/selected/loupe) that render reads;
// game state (mode/editor/game/cands) is read and mutated, and the race chrome
// placed, through the InputDeps passed in at init. Exactly one set of handlers
// per app instance.

import { Vec, dist } from '../geometry';
import { pointerDown, pointerMove, pointerUp, pointerCancel } from '../model/editor';
import { pickEdge } from '../model/centerline';
import { Candidate } from '../model/game';
import { AppState } from '../app-state';
import { worldToScreen, screenToWorld, clampScale } from './camera';
import * as vp from './viewport';
import {
  TOUCH_LIFT,
  TOUCH_TOL_PX,
  LOUPE_MAX_CELL_PX,
  AIM_ZONE_PX,
  BOTTOM_DEADZONE_PAD_PX,
  CONFIRM_BTN_ZONE_PX,
  CONFIRM_FLOAT_MIN_W_PX,
  CONFIRM_FLOAT_GAP_PX,
  CONFIRM_FLOAT_PAD_PX,
  CONFIRM_FLOAT_PAD_RIGHT_PX,
  CONFIRM_FLOAT_PAD_TOP_PX,
  CONFIRM_ANCHOR_HYST_PX,
  DRAG_PX,
  ZOOM_BTN_FACTOR,
  WHEEL_FACTOR,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP_PX,
  DOUBLE_TAP_DRAG_PX_PER_2X,
} from '../config';

/**
 * The race chrome as gestures see it: a confirm button and a status chip
 * somewhere over the board. Input decides *where* those go — it owns the camera
 * and the candidate fan — but never touches their DOM; main.ts wires this to
 * ui/race-chrome.
 */
export interface InputChrome {
  /** Show/hide the "Go!" button. */
  showConfirm(show: boolean): void;
  /** Move the action stack (chip + button) to the half of the field free of candidates. */
  setActAnchor(anchor: 'top' | 'bottom'): void;
  /** Float the confirm button at this top-left corner in board css px; null docks it back. */
  setConfirmFloat(pos: { x: number; y: number } | null): void;
  /** Size of the confirm button as currently rendered; zero while it's hidden. */
  confirmSize(): { w: number; h: number };
  /** The status chip's box in board coordinates, or null when it isn't on screen. */
  chipRect(): { x: number; y: number; w: number; h: number } | null;
  /** How far up from the bottom edge the action stack reaches. */
  actZoneHeight(): number;
}

/**
 * Bridge to the main module: input doesn't hold game state itself. It reads
 * it by reference through `state` (`state.phase`, `state.editor`,
 * `state.game`, `state.cands`) and applies moves/pending picks via callbacks.
 */
export interface InputDeps {
  canvas: HTMLCanvasElement;
  /** Single shared app state (by reference, see app-state.ts). */
  state: AppState;
  /** The confirm button and the status chip — see InputChrome. */
  chrome: InputChrome;
  /** Apply the chosen move (mouse click or touch confirmation). */
  commitMove(cand: Candidate): void;
  /** Not our turn right now, but we can pre-pick a move for later (online/vs bots). */
  isPreselect(): boolean;
  /** Our turn to move — a pending pick can be confirmed right now. */
  myTurn(): boolean;
  /** Pre-pick a move (queued for our next turn) instead of committing/highlighting the button. */
  setPending(cand: Candidate): void;
  updateUI(): void;
  redraw(): void;
  /** The field is no longer under a finger — whatever was put off can run now
   *  (see isGesturing). Called on every path that can end a gesture. */
  gestureEnded(): void;
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
  lastFloatSide = 0; // a new fan starts from the preferred side again
  deps.chrome.showConfirm(false);
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
 * Is the player's hand on the field right now (dragging, pinching, aiming)?
 *
 * The app asks this before starting work that would make the next frames
 * stutter — above all a bot's move, which plans its route synchronously and
 * for a few dozen milliseconds owns the thread the gesture needs to keep the
 * map under the finger. Held work resumes from `gestureEnded`.
 */
export function isGesturing(): boolean {
  return gesture !== null || pinch !== null;
}

/** Announce the end of a gesture — but only once the last one is really over
 *  (lifting one finger of a pinch leaves the other still driving the map). */
function releaseIfIdle(): void {
  if (!isGesturing()) deps.gestureEnded();
}

/**
 * Full reset of input state back to a clean slate. This is a safety net
 * against "phantom" pointers: iOS Safari frequently DROPS the terminal
 * pointerup/pointercancel (hijacked by a system gesture, both fingers lifted
 * at once, app backgrounded) — the finger's record then lingers in
 * `activePointers` forever, and the next single touch is falsely read as a
 * pinch (`size === 2` because of the phantom) → the field zooms and the only
 * way out is a restart.
 *
 * `keepPick` drops the pointer bookkeeping only, leaving the chosen candidate
 * and its "Go!" button alone: that's the tab-switch case (blur / tab hidden),
 * where there is a phantom pointer to fear but no reason to throw away a move
 * the player has already picked.
 */
function resetGestureState(opts: { keepPick?: boolean } = {}): void {
  activePointers.clear();
  pinch = null;
  gesture = null;
  activeId = null;
  loupe = null;
  hover = null;
  canvas.classList.remove('grabbing', 'over-edge');
  if (opts.keepPick) return;
  selected = null;
  syncConfirmMove();
}

/**
 * Show or hide the "Go!" button and (re)place the action zone. The button
 * stands as long as a pick that can still be confirmed does: either a candidate
 * tapped on our own turn (`selected`) or a pre-pick queued during someone
 * else's turn that our turn has now come round to (`state.pending`). Both are
 * drawn on the field, so hiding the button while one of them stands leaves a
 * mark that can't be confirmed.
 *
 * Placement is refreshed on every call, including the hiding ones: the chip and
 * the countdown button are on screen before any pick is made, so where they sit
 * has to be decided as soon as the candidates are known.
 */
export function syncConfirmMove(): void {
  const pending = deps.state.phase === 'race' && deps.state.pending && deps.myTurn();
  deps.chrome.showConfirm(!!(selected || pending));
  updateConfirmPlacement();
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

/**
 * Height of the strip along the bottom of the canvas where a touch is not
 * ours: a swipe up from there is the system "home" gesture (iOS home
 * indicator, Android gesture navigation). Taking such a touch as the start of
 * a stroke is how a swipe-to-minimize used to end as a cancelled gesture and
 * an error toast on the drawing screen.
 *
 * Reads `--pr-safe-bottom` (`env(safe-area-inset-bottom)`, styles/base.css) —
 * getComputedStyle resolves env() for us. Cached: this runs on every
 * pointerdown, and the value only changes when the viewport does.
 */
let deadzonePx: number | null = null;
function bottomDeadzone(): number {
  if (deadzonePx === null) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(
      '--pr-safe-bottom',
    );
    deadzonePx = (parseFloat(raw) || 0) + BOTTOM_DEADZONE_PAD_PX;
  }
  return deadzonePx;
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
  syncConfirmMove();
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

// Both placement decisions are sticky, because both are recomputed on every
// frame of a pan and both have a threshold a drifting fan will sit right on.
// The anchor gets a dead band (see actAnchor); the float remembers which side
// of the fan it took and tries that one first, so it only switches sides when
// the old one has actually become unusable. Reset per turn (clearSelection), so
// a fresh fan starts from the preferred order again.
let lastAnchor: 'top' | 'bottom' = 'bottom';
let lastFloatSide = 0;

/** Screen positions (css px) of the candidates a tap can still land on. */
function candScreenPoints(): Vec[] {
  const cands = deps.state.cands;
  if (!cands) return [];
  const view = vp.camera();
  const pts: Vec[] = [];
  for (const c of cands) {
    if (c.blocked) continue;
    pts.push(worldToScreen(view, c.target));
  }
  return pts;
}

/**
 * Where to show the bottom action stack. Defaults to the bottom; only moves to
 * the top if the lowest candidate actually reaches into the stack's zone near
 * the bottom edge (otherwise a tap on the target would hit the chip or the
 * button — wrong move). Just "below center" doesn't count, so the stack doesn't
 * jump back and forth for no reason.
 *
 * The zone is the stack's real height when it has one (chip + button, and the
 * chip is what covers candidates most often), grown by the tap radius: a target
 * whose centre clears the stack by a few pixels is still half under it, and the
 * tap lands on the chip. CONFIRM_BTN_ZONE_PX is the floor, for the first call
 * before anything has been laid out.
 *
 * Coming back down takes a wider clearance than going up (CONFIRM_ANCHOR_HYST_PX):
 * this runs on every frame of a pan, and a bare threshold makes the whole stack
 * flicker between the two ends while the fan drifts across it.
 */
function actAnchor(pts: Vec[]): 'top' | 'bottom' {
  const { h } = vp.viewSize();
  const zone = Math.max(CONFIRM_BTN_ZONE_PX, deps.chrome.actZoneHeight() + TOUCH_TOL_PX);
  let maxY = -Infinity; // screen Y of the lowest unblocked candidate
  for (const p of pts) maxY = Math.max(maxY, p.y);
  const limit = h - zone - (lastAnchor === 'top' ? CONFIRM_ANCHOR_HYST_PX : 0);
  lastAnchor = maxY > limit ? 'top' : 'bottom';
  return lastAnchor;
}

/**
 * Desktop placement for the floating confirm button: its top-left corner in
 * board css px, or null to leave it docked at the bottom.
 *
 * The button is placed strictly OUTSIDE the fan's bounding box — a player who
 * changes their mind has to be able to reach every other candidate, so covering
 * even one of them is not an option. Below the fan first (the reading order of
 * the move), then above, then to either side; the first placement that fits on
 * the board and touches no candidate wins. Along the fan it lines up with the
 * picked point, so the button still travels to where the eye is.
 *
 * The status chip is a second, softer obstacle: parked across it the button
 * cuts the turn's instruction in half. A placement that clears the chip too is
 * preferred, but a placement that only clears the candidates still beats
 * dropping back to the bottom of the window — which is the distance this whole
 * thing exists to remove.
 */
function confirmFloatPos(
  pts: Vec[],
  pick: Candidate | null,
): { x: number; y: number } | null {
  const { w: vw, h: vh } = vp.viewSize();
  if (vw < CONFIRM_FLOAT_MIN_W_PX || pts.length === 0) return null;
  const { w, h } = deps.chrome.confirmSize();
  if (!w || !h) return null;

  // The fan, grown by the tap tolerance around each point: a button that merely
  // touches the edge of a target's hit area is already in the way.
  const r = Math.max(vp.scale() / 2, TOUCH_TOL_PX);
  const box = {
    x0: Math.min(...pts.map((p) => p.x)) - r,
    x1: Math.max(...pts.map((p) => p.x)) + r,
    y0: Math.min(...pts.map((p) => p.y)) - r,
    y1: Math.max(...pts.map((p) => p.y)) + r,
  };
  const view = vp.camera();
  const aim = pick ? worldToScreen(view, pick.target) : null;
  const cx = aim ? aim.x : (box.x0 + box.x1) / 2;
  const cy = aim ? aim.y : (box.y0 + box.y1) / 2;

  const gap = CONFIRM_FLOAT_GAP_PX;
  // `slide` is the axis the button may be nudged along to stay on the board:
  // it runs parallel to the side of the fan the button sits on, so sliding can
  // never bring it back over a candidate.
  const places = [
    { x: cx - w / 2, y: box.y1 + gap, slide: 'x' as const }, // below the fan
    { x: cx - w / 2, y: box.y0 - gap - h, slide: 'x' as const }, // above it
    { x: box.x1 + gap, y: cy - h / 2, slide: 'y' as const }, // to the right
    { x: box.x0 - gap - w, y: cy - h / 2, slide: 'y' as const }, // to the left
  ];
  const minX = CONFIRM_FLOAT_PAD_PX;
  const maxX = vw - CONFIRM_FLOAT_PAD_RIGHT_PX - w;
  const minY = CONFIRM_FLOAT_PAD_TOP_PX;
  const maxY = vh - CONFIRM_FLOAT_PAD_PX - h;
  if (minX > maxX || minY > maxY) return null; // window too small to hold it anywhere

  const chip = deps.chrome.chipRect();
  // The side used last frame is tried first: while it works the button stays
  // put, instead of hopping back to a "better" side the moment a pan frees it.
  const order = [lastFloatSide, ...places.keys()].filter((i, k, a) => a.indexOf(i) === k);
  let fallback: { side: number; x: number; y: number } | null = null;
  for (const i of order) {
    const p = places[i];
    const x = p.slide === 'x' ? Math.min(Math.max(p.x, minX), maxX) : p.x;
    const y = p.slide === 'y' ? Math.min(Math.max(p.y, minY), maxY) : p.y;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    if (pts.some((c) => c.x > x - r && c.x < x + w + r && c.y > y - r && c.y < y + h + r))
      continue;
    const onChip =
      chip !== null &&
      x < chip.x + chip.w + gap &&
      x + w > chip.x - gap &&
      y < chip.y + chip.h + gap &&
      y + h > chip.y - gap;
    if (!onChip) {
      lastFloatSide = i;
      return { x, y };
    }
    fallback ??= { side: i, x, y };
  }
  // Nothing clears both: the fan fills the board (deep zoom) or it sits right on
  // the chip. Take the chip overlap if there was one, else stay docked — better
  // far away than on top of a target.
  if (fallback) lastFloatSide = fallback.side;
  return fallback && { x: fallback.x, y: fallback.y };
}

/**
 * Re-place the action zone and the floating button for the current camera and
 * candidates, without touching whether the button is shown. Called from the
 * redraw path, so both follow a pan, a pinch and the zoom buttons live.
 */
export function updateConfirmPlacement(): void {
  const pts = candScreenPoints();
  deps.chrome.setActAnchor(actAnchor(pts));
  deps.chrome.setConfirmFloat(confirmFloatPos(pts, selected ?? deps.state.pending));
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

/** How close (in world units) a mouse press has to be to count as hitting an
 *  editor target. Hover and press share it, or the cursor would promise a grab
 *  the press then misses. */
const EDIT_TOL = 1.2;

/**
 * Adjust step, mouse only: the cursor promises what a press would do — a hand
 * over a draggable road edge, the crosshair everywhere else, where a press pans
 * the map instead. CSS scopes the class to the step, so a stale one is inert.
 */
function updateEdgeHover(w: Vec): void {
  const editor = deps.state.editor;
  const over =
    editor.step === 'adjust' && !!editor.width && !!pickEdge(editor.width, w, EDIT_TOL);
  canvas.classList.toggle('over-edge', over);
}

/** Classify a touch-down in the editor: drawing/edge-tuning/finish/arrow, or a pan. */
function handleEditDown(e: PointerEvent, scr: Vec, touch: boolean): void {
  const editor = deps.state.editor;
  const w = vp.toWorld(e, drawLift(e));
  const tol = touch ? Math.max(EDIT_TOL, TOUCH_TOL_PX / vp.scale()) : EDIT_TOL;
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
        canvas.classList.add('grabbing'); // the open hand closes on the edge
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
      // Tapping an arrow flips the (pre-selected) direction; it no longer
      // advances — the primary button does that. A tap that misses simply pans,
      // and a tap that hits leaves a harmless zero-length pan.
      pointerDown(editor, w, tol);
      beginPan(scr.x, scr.y, e.pointerId);
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
      // Desktop click: on the opponent's turn it's a pre-pick; on ours it picks
      // the target and "Go!" commits it — the same two-step as touch aiming.
      // (It used to commit straight from the click, so desktop and touch
      // disagreed about what a tap on the field meant.)
      if (deps.isPreselect()) {
        deps.setPending(g.cand);
      } else {
        selected = g.cand;
        deps.state.pending = null; // a fresh pick on our turn clears any queued move
        syncConfirmMove();
      }
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
        syncConfirmMove();
      }
      break;
    }
    case 'pan':
      // Panning keeps the selection, but the candidates are somewhere else on
      // screen now — re-place the action zone and the floating button, whether
      // or not a target has been picked (the chip can end up over the fan just
      // as easily as the button can).
      syncConfirmMove();
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
    const scr = vp.toScreen(e);
    // A swipe from the bottom edge belongs to the system, not to us: it starts
    // on the canvas but ends as "minimize the app", and the pointercancel that
    // follows would land in the editor as a cut-short stroke (an error toast
    // waiting on the screen when the app is reopened). Drop it before any
    // bookkeeping — no capture, no activePointers entry — so the later
    // pointercancel finds nothing to undo. Measured against the viewport, not
    // the canvas: the strip belongs to the screen edge, wherever the board
    // happens to end.
    if (touch && window.innerHeight - e.clientY < bottomDeadzone()) return;
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
      syncConfirmMove();
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
    // No active gesture: mouse hover only — race candidates, or the draggable
    // road edge in the editor (cursor feedback, nothing to redraw).
    const game = deps.state.game;
    if (!touch && deps.state.phase === 'race' && game && game.phase === 'race') {
      const c = findCandidate(vp.toWorld(e));
      if (c !== hover) {
        hover = c;
        deps.redraw();
      }
    } else if (!touch && deps.state.phase === 'edit') {
      updateEdgeHover(vp.toWorld(e));
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
      releaseIfIdle();
      return;
    }
    if (activeId === null || e.pointerId !== activeId) {
      deps.redraw();
      releaseIfIdle();
      return;
    }
    endGesture(e);
    deps.redraw();
    releaseIfIdle();
  });

  canvas.addEventListener('pointercancel', (e) => {
    const touch = e.pointerType === 'touch';
    if (touch) activePointers.delete(e.pointerId);
    if (pinch) {
      if (activePointers.size < 2) pinch = null;
      deps.redraw();
      releaseIfIdle();
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
    releaseIfIdle();
  });

  // Cursor left the field: clear hover and forget the position, so reaimHover
  // doesn't resurrect hover on the opponent's move once the mouse is no
  // longer over the field. This event doesn't fire during a gesture (pointer
  // is captured) — there the gesture itself drives hover.
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch' || activeId !== null) return;
    lastMouseScreen = null;
    canvas.classList.remove('over-edge');
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
  // The pick itself is deliberately kept (`keepPick`): switching tabs is a
  // routine thing in an async online race, and coming back to a mark on the
  // field with no way to confirm it reads as a breakage. The redraw matters —
  // this path clears hover/loupe without one, and the stale frame is what made
  // the mark look alive while its button was already gone.
  const parkGestures = (): void => {
    resetGestureState({ keepPick: true });
    deps.redraw();
    releaseIfIdle();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) parkGestures();
  });

  // The safe-area inset differs between portrait and landscape — drop the
  // cached dead-zone height so the next pointerdown re-reads it.
  const forgetDeadzone = (): void => {
    deadzonePx = null;
  };
  window.addEventListener('resize', forgetDeadzone);
  window.addEventListener('orientationchange', forgetDeadzone);
  window.addEventListener('blur', parkGestures);

  document.getElementById('zoomIn')?.addEventListener('click', () => zoomByButton(1));
  document.getElementById('zoomOut')?.addEventListener('click', () => zoomByButton(-1));
}
