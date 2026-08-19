// Track drawing phase: a state machine center -> adjust -> finish -> direction -> ready.
// The user draws a centerline, the edges are laid out automatically, and can
// then be fine-tuned by dragging.

import {
  Vec,
  Polyline,
  add,
  sub,
  scale,
  normalize,
  dot,
  dist,
  lerp,
  smoothClosed,
  distPointToPath,
  selfIntersectsClosed,
  polygonArea,
} from '../geometry';
import { FinishLine, processStroke, clipFinishLine } from './track';
import {
  WidthModel,
  generateEdges,
  rebuildEdges,
  pickEdge,
  applyEdgeDrag,
  autoFinishIndex,
} from './centerline';
import { strings } from '../i18n';
import { MIN_CENTER_AREA } from '../config';

export type EditorStep = 'center' | 'adjust' | 'finish' | 'direction' | 'ready';

export interface Arrow {
  /** Tail and head of the arrow — the ends of `path`, kept for hit-tests and dev helpers. */
  from: Vec;
  tip: Vec;
  forward: Vec;
  /** The drawn shaft: it follows the road rather than cutting across it. */
  path: Polyline;
}

export interface EditorState {
  step: EditorStep;
  /** Track centerline (closed polyline). */
  center: Polyline | null;
  /** Width model: normals and edge offsets along the centerline. */
  width: WidthModel | null;
  outer: Polyline | null;
  inner: Polyline | null;
  finish: FinishLine | null;
  forward: Vec | null;
  arrows: [Arrow, Arrow] | null;
  /** Raw freehand stroke while drawing the centerline. */
  stroke: Vec[];
  drawing: boolean;
  /** Dragging out the finish line. */
  dragStart: Vec | null;
  dragEnd: Vec | null;
  /** Edge tuning: which side and vertex is being dragged. */
  dragEdge: 'outer' | 'inner' | null;
  dragIndex: number | null;
  message: string;
  error: boolean;
}

const MSG: Record<EditorStep, string> = strings.editor.step;

/** The step's inviting prompt — what's shown when there's no error standing. */
export function stepPrompt(step: EditorStep): string {
  return MSG[step];
}

export function newEditor(): EditorState {
  return {
    step: 'center',
    center: null,
    width: null,
    outer: null,
    inner: null,
    finish: null,
    forward: null,
    arrows: null,
    stroke: [],
    drawing: false,
    dragStart: null,
    dragEnd: null,
    dragEdge: null,
    dragIndex: null,
    message: MSG.center,
    error: false,
  };
}

function setStep(st: EditorState, step: EditorStep): void {
  st.step = step;
  st.message = MSG[step];
  st.error = false;
}

function fail(st: EditorState, message: string): void {
  st.message = message;
  st.error = true;
}

export function pointerDown(st: EditorState, p: Vec, tol = 1.2): void {
  // A fresh attempt clears the previous error/prompt (so, e.g., a second
  // self-crossing draw or a second cancelled gesture re-shows the error toast
  // rather than being deduped).
  st.error = false;
  st.message = MSG[st.step];
  if (st.step === 'center') {
    st.drawing = true;
    st.stroke = [p];
  } else if (st.step === 'adjust' && st.width) {
    const pick = pickEdge(st.width, p, tol);
    if (pick) {
      st.dragEdge = pick.edge;
      st.dragIndex = pick.index;
    }
  } else if (st.step === 'finish' && st.width) {
    st.dragStart = p;
    previewFinish(st, p);
  } else if (st.step === 'direction' && st.arrows) {
    // Direction is pre-selected; tapping an arrow only flips which way is
    // forward — advancing to the next screen is the explicit primary button.
    for (const arrow of st.arrows) {
      if (distPointToPath(p, arrow.path) < tol) {
        st.forward = arrow.forward;
        return;
      }
    }
  }
}

export function pointerMove(st: EditorState, p: Vec): void {
  if (st.drawing) {
    const last = st.stroke[st.stroke.length - 1];
    if (!last || dist(last, p) > 0.15) st.stroke.push(p);
  } else if (
    st.step === 'adjust' &&
    st.width &&
    st.dragEdge !== null &&
    st.dragIndex !== null
  ) {
    if (applyEdgeDrag(st.width, st.dragEdge, st.dragIndex, p)) {
      const e = rebuildEdges(st.width);
      st.outer = e.outer;
      st.inner = e.inner;
    }
  } else if (st.step === 'finish' && st.dragStart && st.width) {
    st.dragStart = p;
    previewFinish(st, p);
  }
}

export function pointerUp(st: EditorState): void {
  if (st.drawing) {
    st.drawing = false;
    const raw = st.stroke;
    st.stroke = [];
    const res = processStroke(raw);
    if ('error' in res) {
      fail(st, res.error);
      return;
    }
    if (st.step === 'center') {
      if (selfIntersectsClosed(res.poly)) {
        fail(st, strings.editor.errors.selfCross);
        return;
      }
      if (polygonArea(res.poly) < MIN_CENTER_AREA) {
        fail(st, strings.editor.errors.tooSmall);
        return;
      }
      const gen = generateEdges(res.poly);
      if ('error' in gen) {
        fail(st, gen.error);
        return;
      }
      st.center = res.poly;
      st.width = gen.model;
      st.outer = gen.outer;
      st.inner = gen.inner;
      setStep(st, 'adjust');
    }
  } else if (st.step === 'adjust') {
    st.dragEdge = null;
    st.dragIndex = null;
  } else if (st.step === 'finish' && st.dragStart && st.width) {
    // Relocating the auto-placed start/finish: commit the tapped position if it
    // sits on the road, otherwise keep the previous (valid) placement — a stray
    // tap shouldn't wipe out a line that's already there. Advancing is the Next
    // button (confirmFinish), not this gesture.
    const p = st.dragStart;
    st.dragStart = null;
    st.dragEnd = null;
    const res = clipPerpAt(st.width, p, st.outer!, st.inner!);
    if ('error' in res) {
      // Say why nothing moved — silently leaving the old line there reads as a
      // dead tap.
      fail(st, strings.editor.errors.finishMiss);
      return;
    }
    st.finish = res.finish;
    st.error = false;
  }
}

/** Direction across the track at point p — the normal of the nearest centerline vertex. */
function perpDirAt(width: WidthModel, p: Vec): Vec {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < width.center.length; i++) {
    const d = dist(p, width.center[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return width.outNormal[best];
}

/** Directions tried across a half-turn when hunting for the narrowest crossing. */
const FINISH_SWEEP_STEPS = 36;
/** Rounds of narrowing down around the best direction of the coarse sweep. */
const FINISH_REFINE_ROUNDS = 2;
/** A crossing at most this much longer than the narrowest one still counts as
 *  just as good, so the centerline normal can win the tie. */
const FINISH_TIE_SLACK = 1.05;

interface Crossing {
  /** The line itself, without the 0.25 clipFinishLine sticks out past each wall. */
  len: number;
  angle: number;
  finish: FinishLine;
}

/** Angle between two undirected directions, in [0, PI/2]. */
function angleGap(a: number, b: number): number {
  const d = Math.abs(a - b) % Math.PI;
  return d > Math.PI / 2 ? Math.PI - d : d;
}

/**
 * Finish line through point p: the SHORTEST segment joining the two walls
 * through it. Across is by definition the narrowest way through the road, so
 * the shortest crossing is the one that runs square across it.
 *
 * The centerline normal alone can't do this job: where the road doubles back on
 * itself, the centerline vertex nearest to p belongs to the neighbouring stretch,
 * and its normal points along p's own road rather than across it — the line then
 * ran for tens of cells down the tarmac. It stays on as a hint for the tie-break
 * below, which is all it can be trusted with.
 */
export function clipPerpAt(
  width: WidthModel,
  p: Vec,
  outer: Polyline,
  inner: Polyline,
): ReturnType<typeof clipFinishLine> {
  const hint = perpDirAt(width, p);
  const hintAngle = Math.atan2(hint.y, hint.x);
  const found: Crossing[] = [];
  let miss: ReturnType<typeof clipFinishLine> = { error: 'no-cross' };

  const measure = (angle: number): Crossing | null => {
    const d = { x: Math.cos(angle), y: Math.sin(angle) };
    const res = clipFinishLine(sub(p, d), add(p, d), outer, inner);
    if ('error' in res) {
      miss = res;
      return null;
    }
    const c = { len: dist(res.finish.a, res.finish.b) - 0.5, angle, finish: res.finish };
    found.push(c);
    return c;
  };

  // A direction and its opposite give the same line, so half a turn covers them
  // all. Starting from the hint keeps the centerline normal itself among the
  // candidates, whatever the step size.
  const step = Math.PI / FINISH_SWEEP_STEPS;
  let best: Crossing | null = null;
  for (let k = 0; k < FINISH_SWEEP_STEPS; k++) {
    const c = measure(hintAngle + k * step);
    if (c && (!best || c.len < best.len)) best = c;
  }
  if (!best) return miss;

  // The coarse step is far too wide to place the line accurately on a narrow
  // road, so close in on the winner.
  let half = step;
  for (let round = 0; round < FINISH_REFINE_ROUNDS; round++) {
    half /= 4;
    for (const side of [-2, -1, 1, 2]) {
      const c = measure(best.angle + side * half);
      if (c && c.len < best.len) best = c;
    }
  }

  // On a bend the true narrowest crossing tilts a little toward the apex, which
  // reads as a crooked line. Among the directions that are as good as the best,
  // prefer the one closest to the centerline normal — on a folded-back road the
  // hint is nowhere near this good, so it can't win the tie there.
  const cutoff = best.len * FINISH_TIE_SLACK;
  let pick = best;
  let pickGap = angleGap(best.angle, hintAngle);
  for (const c of found) {
    if (c.len > cutoff) continue;
    const gap = angleGap(c.angle, hintAngle);
    if (gap < pickGap) {
      pick = c;
      pickGap = gap;
    }
  }
  return { finish: pick.finish };
}

/**
 * Update the finish-line preview from the current pointer position. A position
 * with no line to draw (off the road, or too narrow a spot) leaves the previous
 * one standing: the step always arrives with a valid line, and a finger passing
 * over the grass shouldn't wipe it out — the tap is a move, not a delete.
 */
function previewFinish(st: EditorState, p: Vec): void {
  const res = clipPerpAt(st.width!, p, st.outer!, st.inner!);
  if (!('error' in res)) st.finish = res.finish;
  st.error = false;
}

/** Gesture interrupted (pointercancel): reset any unfinished stroke/line/drag and report it. */
export function pointerCancel(st: EditorState): void {
  st.drawing = false;
  st.stroke = [];
  st.dragStart = null;
  st.dragEnd = null;
  st.dragEdge = null;
  st.dragIndex = null;
  fail(st, strings.editor.gestureCancelled);
}

/**
 * Place the default start/finish: a wide spot near the end of a long straight
 * (autoFinishIndex). Tries that vertex first, then falls back to the widest
 * vertices, so we always end up with a valid line on a normal track.
 */
function placeDefaultFinish(st: EditorState): void {
  if (!st.width || !st.outer || !st.inner) return;
  const m = st.width;
  const tryAt = (i: number): FinishLine | null => {
    const res = clipPerpAt(m, m.center[i], st.outer!, st.inner!);
    return 'error' in res ? null : res.finish;
  };
  let f = tryAt(autoFinishIndex(m));
  if (!f) {
    // Widest vertices first — the roomiest spots are the likeliest to clip cleanly.
    const order = [...m.center.keys()].sort(
      (a, b) => m.outW[b] + m.inW[b] - (m.outW[a] + m.inW[a]),
    );
    for (const i of order) {
      f = tryAt(i);
      if (f) break;
    }
  }
  st.finish = f;
}

/** Confirm the edges and move on to placing the start/finish (auto-placed). */
export function confirmEdges(st: EditorState): void {
  if (st.step !== 'adjust') return;
  setStep(st, 'finish');
  placeDefaultFinish(st);
}

/** Confirm the start/finish and move on to the (pre-selected) racing direction. */
export function confirmFinish(st: EditorState): void {
  if (st.step !== 'finish' || !st.finish) return;
  computeArrows(st);
  st.forward = st.arrows![0].forward; // pre-select a direction; a tap can flip it
  setStep(st, 'direction');
}

/**
 * Confirm the racing direction. `ready` is a transient state: the caller
 * immediately routes on to mode selection — there's no standalone "ready"
 * screen. Kept as a distinct step so stepping back from setup lands on
 * `direction` with the chosen arrow still selected.
 */
export function confirmDirection(st: EditorState): void {
  if (st.step === 'direction' && st.forward) setStep(st, 'ready');
}

/** Arc length from the finish where a direction arrow starts and ends, in cells. */
const ARROW_NEAR = 1.2;
const ARROW_FAR = 4;
/** Spacing of the arrow's path vertices — fine enough to read as a curve. */
const ARROW_STEP = 0.4;
/** An arrow never eats more than this much of the loop (tiny tracks). */
const ARROW_LOOP_FRAC = 1 / 6;

/**
 * The road's mid-lane: halfway between the two edges, so an arrow drawn on it
 * stays in the middle of the asphalt even where the widths differ. Smoothed,
 * because the centerline is a hand-drawn stroke and its wobble would show up as
 * a zigzag over the arrow's few cells.
 */
function midLane(m: WidthModel): Polyline {
  const raw = m.center.map((p, i) =>
    add(p, scale(m.outNormal[i], (m.outW[i] - m.inW[i]) / 2)),
  );
  return smoothClosed(raw, 6, 0.5);
}

/** Total length of a closed polyline. */
function ringLength(poly: Polyline): number {
  let total = 0;
  for (let i = 0; i < poly.length; i++)
    total += dist(poly[i], poly[(i + 1) % poly.length]);
  return total;
}

/** Index of the ring vertex nearest to p. */
function nearestIndex(poly: Polyline, p: Vec): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = dist(p, poly[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** The point `target` cells along the ring from vertex i0, walking in `dir`. */
function walkRing(poly: Polyline, i0: number, dir: 1 | -1, target: number): Vec {
  const n = poly.length;
  let acc = 0;
  let i = i0;
  for (let k = 0; k < n; k++) {
    const j = (i + dir + n) % n;
    const seg = dist(poly[i], poly[j]);
    if (acc + seg >= target) {
      return seg < 1e-9 ? poly[j] : lerp(poly[i], poly[j], (target - acc) / seg);
    }
    acc += seg;
    i = j;
  }
  return poly[i];
}

function computeArrows(st: EditorState): void {
  const f = st.finish!;
  const m = lerp(f.a, f.b, 0.5);
  const d = normalize(sub(f.b, f.a));
  const n = { x: -d.y, y: d.x };
  const lane = midLane(st.width!);
  const i0 = nearestIndex(lane, m);
  // Cap the reach so an arrow can't wrap around a very short loop.
  const far = Math.min(ARROW_FAR, ringLength(lane) * ARROW_LOOP_FRAC);
  const near = Math.min(ARROW_NEAR, far * 0.4);

  const build = (forward: Vec): Arrow => {
    // Which way round the ring is "forward" — decided by the lane's own tangent
    // at the finish, since the ring's winding is whatever the user drew.
    const ahead = sub(lane[(i0 + 1) % lane.length], lane[i0]);
    const dir: 1 | -1 = dot(ahead, forward) >= 0 ? 1 : -1;
    // Even spacing over a whole number of steps — a leftover sliver at the head
    // would be a zero-length segment for the head's direction to be read from.
    const steps = Math.max(2, Math.ceil((far - near) / ARROW_STEP));
    const path: Polyline = [];
    for (let k = 0; k <= steps; k++) {
      path.push(walkRing(lane, i0, dir, near + ((far - near) * k) / steps));
    }
    return { from: path[0], tip: path[path.length - 1], forward, path };
  };

  st.arrows = [build(n), build(scale(n, -1))];
}

export function resetCenter(st: EditorState): void {
  st.center = null;
  st.width = null;
  st.outer = null;
  st.inner = null;
  st.finish = null;
  st.forward = null;
  st.arrows = null;
  st.drawing = false;
  st.stroke = [];
  st.dragStart = null;
  st.dragEnd = null;
  st.dragEdge = null;
  st.dragIndex = null;
  setStep(st, 'center');
}

/** Return to edge tuning, keeping the centerline and the generated surface. */
export function resetAdjust(st: EditorState): void {
  if (!st.width) return;
  st.finish = null;
  st.forward = null;
  st.arrows = null;
  st.dragStart = null;
  st.dragEnd = null;
  st.dragEdge = null;
  st.dragIndex = null;
  setStep(st, 'adjust');
}

export function resetFinish(st: EditorState): void {
  if (!st.inner) return;
  st.forward = null;
  st.arrows = null;
  st.dragStart = null;
  st.dragEnd = null;
  setStep(st, 'finish');
  // Keep the user's placement if there is one; otherwise re-place the default so
  // the finish step always arrives with a line already on the track.
  if (!st.finish) placeDefaultFinish(st);
}

/** A single step back through the drawing state machine. */
export function stepBack(st: EditorState): void {
  switch (st.step) {
    case 'adjust':
      resetCenter(st);
      break;
    case 'finish':
      resetAdjust(st);
      break;
    case 'direction':
      resetFinish(st);
      break;
    case 'ready':
      // Final validation failed (too narrow / no room for a start) — instead of
      // stepping back manually through direction->finish->adjust, jump straight
      // to edge tuning, where the width can actually be fixed.
      if (st.error) {
        resetAdjust(st);
      } else {
        // Keep the chosen direction selected when returning from setup.
        setStep(st, 'direction');
      }
      break;
    // 'center' is the first step — there's nowhere to go back to.
  }
}

/** Whether a step back is possible from the current phase. */
export function canStepBack(st: EditorState): boolean {
  return st.step !== 'center';
}

/**
 * A ready-made editor "snapshot" built from an already-finalized track — used
 * to preview the track in the lobby for a guest who never drew it themselves.
 * The `ready` phase renders the edges and finish without arrows/tuning.
 */
export function editorFromTrack(t: {
  outer: Polyline;
  inner: Polyline;
  finish: FinishLine;
  forward: Vec;
}): EditorState {
  const st = newEditor();
  st.step = 'ready';
  st.outer = t.outer;
  st.inner = t.inner;
  st.finish = t.finish;
  st.forward = t.forward;
  return st;
}
