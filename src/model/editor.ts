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
  dist,
  lerp,
  distPointToSegment,
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
  from: Vec;
  tip: Vec;
  forward: Vec;
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
  if (st.step === 'center') {
    st.drawing = true;
    st.stroke = [p];
    // A fresh attempt clears the previous error/prompt (so, e.g., a second
    // self-crossing draw re-shows the error toast rather than being deduped).
    st.error = false;
    st.message = MSG.center;
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
      if (distPointToSegment(p, arrow.from, arrow.tip) < tol) {
        st.forward = arrow.forward;
        st.error = false;
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
    if (!('error' in res)) st.finish = res.finish;
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

/**
 * Finish line through point p, perpendicular to the centerline: take the
 * normal of the nearest centerline vertex and clip a short segment along it
 * to the edges.
 */
function clipPerpAt(
  width: WidthModel,
  p: Vec,
  outer: Polyline,
  inner: Polyline,
): ReturnType<typeof clipFinishLine> {
  const d = perpDirAt(width, p);
  return clipFinishLine(sub(p, d), add(p, d), outer, inner);
}

/** Update the finish-line preview from the current pointer position. */
function previewFinish(st: EditorState, p: Vec): void {
  const res = clipPerpAt(st.width!, p, st.outer!, st.inner!);
  st.finish = 'error' in res ? null : res.finish;
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
  if (st.step === 'finish') st.finish = null;
  st.message = strings.editor.gestureCancelled;
  st.error = false;
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

function computeArrows(st: EditorState): void {
  const f = st.finish!;
  const m = lerp(f.a, f.b, 0.5);
  const d = normalize(sub(f.b, f.a));
  const n = { x: -d.y, y: d.x };
  st.arrows = [
    { from: add(m, scale(n, 1.2)), tip: add(m, scale(n, 4)), forward: n },
    { from: add(m, scale(n, -1.2)), tip: add(m, scale(n, -4)), forward: scale(n, -1) },
  ];
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
