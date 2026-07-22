// Building a track from a centerline: a random smooth width is laid out from the
// centerline to both sides, with local shrinking so the edges never overlap
// themselves or neighboring parts of the track. Also handles rebuilding the
// edges after manual tuning (dragging edge points).

import {
  Vec,
  Polyline,
  add,
  sub,
  scale,
  dot,
  cross,
  len,
  dist,
  closedNormals,
  distPointToSegment,
  closestPointOnSegment,
  selfIntersectsClosed,
  pointInPolygon,
  segmentPolylineIntersections,
  resampleClosed,
  smoothClosed,
} from '../geometry';
import { strings } from '../i18n';
import { WIDTH_MIN, WIDTH_MAX, WORLD_SIZE, GAP_MIN } from '../config';

// Range of overall track width (cells) — re-exported from config for external imports.
export { WIDTH_MIN, WIDTH_MAX };

/** Lower bound on half-width: any narrower and the road wouldn't have room for cells. */
const HALF_MIN = 0.7;
/** Grass gap between closely-passing parts of the track, in cells. */
const SELF_GAP = 1.0;
/** Fraction of the curvature radius up to which a concave edge may be offset. */
const CURV_SAFETY = 0.85;
/** Edge margin from the world boundary. */
const WORLD_MARGIN = 0.3;
/** Smoothing of the final edge: number of passes and strength (0..1). */
const EDGE_SMOOTH_ITERS = 4;
const EDGE_SMOOTH_FACTOR = 0.5;
/** Target resampling step for the centerline: keeps vertex count within reasonable bounds. */
const CENTER_MAX_VERTS = 380;

/** Track width data: centerline, normals, and edge offsets at every vertex. */
export interface WidthModel {
  center: Polyline;
  /** Unit outward normal at each centerline vertex. */
  outNormal: Vec[];
  /** Offset from the centerline to the outer edge at each vertex. */
  outW: number[];
  /** Offset from the centerline to the inner edge at each vertex. */
  inW: number[];
}

/** Upper bounds on edge offset at a vertex (proximity, curvature, world edge). */
export interface OffsetCaps {
  maxOut: number[];
  maxIn: number[];
}

/** Cumulative arc length over the vertices of a closed polyline, plus total length. */
function arcLengths(poly: Polyline): { cum: number[]; total: number } {
  const n = poly.length;
  const cum: number[] = new Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    cum[i] = s;
    s += dist(poly[i], poly[(i + 1) % n]);
  }
  return { cum, total: s };
}

/** Shortest distance around the ring between two arc positions. */
function arcGap(a: number, b: number, total: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, total - d);
}

/**
 * Random overall width at every vertex: a handful of control values spread
 * evenly along the arc, smoothly interpolated around the ring and smoothed.
 */
function randomWidths(center: Polyline): number[] {
  const n = center.length;
  const { total } = arcLengths(center);
  const k = Math.max(3, Math.round(total / 12));
  const ctrl = Array.from(
    { length: k },
    () => WIDTH_MIN + Math.random() * (WIDTH_MAX - WIDTH_MIN),
  );
  const w: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const f = (i / n) * k; // vertex position on the control-point scale
    const i0 = Math.floor(f) % k;
    const i1 = (i0 + 1) % k;
    // Cosine interpolation between neighboring control values.
    const t = (1 - Math.cos((f - Math.floor(f)) * Math.PI)) / 2;
    w[i] = ctrl[i0] + (ctrl[i1] - ctrl[i0]) * t;
  }
  return smoothRing(w, 2);
}

/** Smooth a ring-shaped array by averaging with its neighbors. */
function smoothRing(arr: number[], iterations: number): number[] {
  const n = arr.length;
  let a = arr;
  for (let it = 0; it < iterations; it++) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = (a[(i - 1 + n) % n] + 2 * a[i] + a[(i + 1) % n]) / 4;
    }
    a = out;
  }
  return a;
}

/**
 * Maximum offset from point p along the unit direction d before hitting the
 * world boundary (inset by WORLD_MARGIN). Returns Infinity if the direction
 * doesn't approach any boundary.
 */
function worldCap(p: Vec, d: Vec): number {
  let t = Infinity;
  if (d.x > 1e-9) t = Math.min(t, (WORLD_SIZE - WORLD_MARGIN - p.x) / d.x);
  else if (d.x < -1e-9) t = Math.min(t, (WORLD_MARGIN - p.x) / d.x);
  if (d.y > 1e-9) t = Math.min(t, (WORLD_SIZE - WORLD_MARGIN - p.y) / d.y);
  else if (d.y < -1e-9) t = Math.min(t, (WORLD_MARGIN - p.y) / d.y);
  return Math.max(0, t);
}

/**
 * Edge offset limits at each vertex:
 *  - proximity to other parts of the track (a loop running close to itself);
 *  - curvature radius on the concave side (a tight turn);
 *  - the world edge.
 */
export function offsetCaps(center: Polyline, outNormal: Vec[]): OffsetCaps {
  const n = center.length;
  const { cum, total } = arcLengths(center);
  const maxOut = new Array(n).fill(Infinity);
  const maxIn = new Array(n).fill(Infinity);
  // Segments closer than this along the arc aren't counted as "another part"
  // (they're just this vertex's own neighbors).
  const nearArc = WIDTH_MAX * 1.5;

  for (let i = 0; i < n; i++) {
    const p = center[i];

    // 1. Proximity to non-adjacent parts of the centerline: both edges split the gap in half.
    let dSelf = Infinity;
    for (let j = 0; j < n; j++) {
      const midArc = (cum[j] + cum[(j + 1) % n]) / 2;
      if (arcGap(cum[i], midArc, total) < nearArc) continue;
      dSelf = Math.min(dSelf, distPointToSegment(p, center[j], center[(j + 1) % n]));
    }
    if (dSelf < Infinity) {
      const half = Math.max(HALF_MIN, (dSelf - SELF_GAP) / 2);
      maxOut[i] = Math.min(maxOut[i], half);
      maxIn[i] = Math.min(maxIn[i], half);
    }

    // 2. Curvature: offset on the concave side is limited by the turn radius.
    const prev = center[(i - 1 + n) % n];
    const next = center[(i + 1) % n];
    const eIn = sub(p, prev);
    const eOut = sub(next, p);
    const li = len(eIn);
    const lo = len(eOut);
    if (li > 1e-6 && lo > 1e-6) {
      const din = scale(eIn, 1 / li);
      const dout = scale(eOut, 1 / lo);
      const theta = Math.atan2(Math.abs(cross(din, dout)), dot(din, dout));
      if (theta > 1e-3) {
        const R = (li + lo) / 2 / theta; // curvature radius
        const cap = Math.max(HALF_MIN, CURV_SAFETY * R);
        // The concave side is wherever the turn's bisector points.
        const bis = add(scale(din, -1), dout); // ~ direction toward the curvature center
        if (dot(bis, outNormal[i]) > 0) maxOut[i] = Math.min(maxOut[i], cap);
        else maxIn[i] = Math.min(maxIn[i], cap);
      }
    }

    // 3. World edge.
    maxOut[i] = Math.min(maxOut[i], worldCap(p, outNormal[i]));
    maxIn[i] = Math.min(maxIn[i], worldCap(p, scale(outNormal[i], -1)));
  }
  return { maxOut, maxIn };
}

/**
 * Build the edges from the centerline, normals, and offsets, with a final
 * smoothing pass so the boundary is always a smooth curve (no sharp corners or
 * jaggies from width noise or where the freehand stroke closes up). Vertex
 * count is preserved — edge indices correspond to centerline vertices (needed
 * for dragging).
 */
export function offsetEdges(
  center: Polyline,
  outNormal: Vec[],
  outW: number[],
  inW: number[],
): { outer: Polyline; inner: Polyline } {
  const outer: Polyline = [];
  const inner: Polyline = [];
  for (let i = 0; i < center.length; i++) {
    outer.push(add(center[i], scale(outNormal[i], outW[i])));
    inner.push(sub(center[i], scale(outNormal[i], inW[i])));
  }
  return {
    outer: smoothClosed(outer, EDGE_SMOOTH_ITERS, EDGE_SMOOTH_FACTOR),
    inner: smoothClosed(inner, EDGE_SMOOTH_ITERS, EDGE_SMOOTH_FACTOR),
  };
}

/** Whether every vertex lies within the world bounds (accounting for margin). */
function withinWorld(poly: Polyline): boolean {
  for (const p of poly) {
    if (p.x < 0 || p.y < 0 || p.x > WORLD_SIZE || p.y > WORLD_SIZE) return false;
  }
  return true;
}

/**
 * Whether there's a grass strip thinner than minGap between non-adjacent parts
 * of edge target (probe is the ring whose vertices we're checking). For each
 * probe vertex we take the closest point on a non-adjacent segment of target;
 * if the midpoint of that gap lies off the road, it's a grass strip, not just
 * the narrow band of road between the outer and inner edge. Arc neighbors are
 * skipped (sameRing), same as in offsetCaps. The "off the road" check
 * (O(n) via pointInPolygon) is gated by the minGap threshold, so it only fires
 * on the rare close approaches — overall complexity is ~O(n^2).
 */
function neckThinnerThan(
  probe: Polyline,
  target: Polyline,
  outer: Polyline,
  inner: Polyline,
  sameRing: boolean,
  minGap: number,
): boolean {
  const nearArc = WIDTH_MAX * 1.5;
  const { cum: pc, total: pt } = arcLengths(probe);
  const { cum: tc, total: tt } = arcLengths(target);
  const nt = target.length;
  for (let i = 0; i < probe.length; i++) {
    const p = probe[i];
    for (let j = 0; j < nt; j++) {
      if (sameRing) {
        // The closing segment's end is total, not cum[0]=0 (otherwise its
        // midpoint would land at the ring's middle and vertex 0's neighbor
        // wouldn't get excluded).
        const midArc = (tc[j] + (j + 1 < nt ? tc[j + 1] : tt)) / 2;
        if (arcGap(pc[i], midArc, pt) < nearArc) continue; // this is our own arc neighbor
      }
      const c = closestPointOnSegment(p, target[j], target[(j + 1) % nt]);
      if (dist(p, c) >= minGap) continue; // not thinner than the threshold — not a strip
      const mid = { x: (p.x + c.x) / 2, y: (p.y + c.y) / 2 };
      const onRoad = pointInPolygon(mid, outer) && !pointInPolygon(mid, inner);
      if (!onRoad) return true;
    }
  }
  return false;
}

/**
 * Whether there's anywhere a grass strip thinner than minGap between two passes
 * of the track. A too-thin strip is a bug: a move straight through it doesn't
 * register as a crash (depth past the edge stays <= OFFROAD_FORGIVE), letting a
 * car cross onto another lap segment. Checks non-adjacent segment pairs of each
 * edge against itself and the outer edge against the inner one.
 */
export function hasNarrowGrassNeck(
  outer: Polyline,
  inner: Polyline,
  minGap: number,
): boolean {
  return (
    neckThinnerThan(outer, outer, outer, inner, true, minGap) ||
    neckThinnerThan(inner, inner, outer, inner, true, minGap) ||
    neckThinnerThan(outer, inner, outer, inner, false, minGap)
  );
}

/** Whether the edges are valid: within the world, each is simple, the inner one
 *  nests without intersections, and there's no thin grass strip between passes
 *  (which would let a car drive straight through). */
export function edgesValid(outer: Polyline, inner: Polyline): boolean {
  if (!withinWorld(outer) || !withinWorld(inner)) return false;
  if (selfIntersectsClosed(outer) || selfIntersectsClosed(inner)) return false;
  for (const p of inner) if (!pointInPolygon(p, outer)) return false;
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i];
    const b = inner[(i + 1) % inner.length];
    if (segmentPolylineIntersections(a, b, outer).length > 0) return false;
  }
  if (hasNarrowGrassNeck(outer, inner, GAP_MIN)) return false;
  return true;
}

export type GenerateResult =
  { model: WidthModel; outer: Polyline; inner: Polyline } | { error: string };

/**
 * Generate edges from the centerline: random width, clamped down to the
 * proximity/curvature/edge limits. If the edges still overlap somewhere after
 * clamping, shrink the width slightly and globally a few times; otherwise, fail.
 */
export function generateEdges(centerRaw: Polyline): GenerateResult {
  // Resampling keeps vertex count bounded (fast dragging) and even.
  const { total } = arcLengths(centerRaw);
  const center = resampleClosed(centerRaw, Math.max(1, total / CENTER_MAX_VERTS));
  const outNormal = closedNormals(center);
  const caps = offsetCaps(center, outNormal);
  const w = randomWidths(center);
  const n = center.length;

  const clampCaps = (arr: number[], cap: number[]): void => {
    for (let i = 0; i < n; i++) arr[i] = Math.max(HALF_MIN, Math.min(arr[i], cap[i]));
  };

  let outW = new Array(n);
  let inW = new Array(n);
  for (let i = 0; i < n; i++) outW[i] = inW[i] = w[i] / 2;
  clampCaps(outW, caps.maxOut);
  clampCaps(inW, caps.maxIn);
  // Alternate width smoothing with clamping to the limits: the result ends up
  // both smooth and valid.
  for (let pass = 0; pass < 2; pass++) {
    outW = smoothRing(outW, 2);
    inW = smoothRing(inW, 2);
    clampCaps(outW, caps.maxOut);
    clampCaps(inW, caps.maxIn);
  }

  const model: WidthModel = { center, outNormal, outW, inW };
  for (let attempt = 0; attempt < 5; attempt++) {
    const { outer, inner } = rebuildEdges(model);
    if (edgesValid(outer, inner)) return { model, outer, inner };
    // Try shrinking further — globally, but gently.
    for (let i = 0; i < n; i++) {
      model.outW[i] = Math.max(HALF_MIN, model.outW[i] * 0.85);
      model.inW[i] = Math.max(HALF_MIN, model.inW[i] * 0.85);
    }
  }
  return { error: strings.centerline.selfOverlap };
}

/** Rebuild the model's edges (after editing outW/inW). */
export function rebuildEdges(m: WidthModel): { outer: Polyline; inner: Polyline } {
  return offsetEdges(m.center, m.outNormal, m.outW, m.inW);
}

/**
 * Index of the centerline vertex closest to point p, and which side
 * (outer/inner) its edge belongs to, if p falls within tolerance. Otherwise null.
 */
export function pickEdge(
  m: WidthModel,
  p: Vec,
  tol: number,
): { edge: 'outer' | 'inner'; index: number } | null {
  const { outer, inner } = rebuildEdges(m);
  let best: { edge: 'outer' | 'inner'; index: number } | null = null;
  let bestD = tol;
  for (let i = 0; i < outer.length; i++) {
    const dO = dist(p, outer[i]);
    if (dO < bestD) {
      bestD = dO;
      best = { edge: 'outer', index: i };
    }
    const dI = dist(p, inner[i]);
    if (dI < bestD) {
      bestD = dI;
      best = { edge: 'inner', index: i };
    }
  }
  return best;
}

/**
 * Apply a drag: move edge `edge` at vertex `index` toward point p (projected
 * onto the normal), with a smooth falloff onto its neighbors. The dragged point
 * follows the pointer exactly (no per-vertex clamping, which used to make it
 * "stick" while the surrounding band of road kept moving). If the full offset
 * would make the edge invalid (overlapping another part of the track, or going
 * off the world), we bisect for the farthest valid position, so the edge smoothly
 * "runs up against" the limit. The model is only ever updated to a valid state.
 * Returns true if anything actually moved.
 */
export function applyEdgeDrag(
  m: WidthModel,
  edge: 'outer' | 'inner',
  index: number,
  p: Vec,
): boolean {
  const n = m.center.length;
  const nrm = edge === 'outer' ? m.outNormal[index] : scale(m.outNormal[index], -1);
  const base = edge === 'outer' ? m.outW : m.inW;
  const cur = base[index];
  // Desired offset of the dragged vertex: pointer projected onto the normal (floored).
  const desired = Math.max(HALF_MIN, dot(sub(p, m.center[index]), nrm));
  const R = Math.max(6, Math.round(n / 10)); // falloff window onto neighbors

  // Offset array at fraction alpha of the way from the current position to desired.
  const build = (alpha: number): number[] => {
    const target = cur + (desired - cur) * alpha;
    const next = base.slice();
    for (let k = -R; k <= R; k++) {
      const i = (index + k + n) % n;
      const wgt = 0.5 * (1 + Math.cos((Math.PI * k) / (R + 1))); // 1 at the center -> 0 at the edges
      next[i] = Math.max(HALF_MIN, base[i] + (target - base[i]) * wgt);
    }
    return next;
  };
  const tryAlpha = (alpha: number): number[] | null => {
    const next = build(alpha);
    const trial: WidthModel = {
      center: m.center,
      outNormal: m.outNormal,
      outW: edge === 'outer' ? next : m.outW,
      inW: edge === 'inner' ? next : m.inW,
    };
    const { outer, inner } = rebuildEdges(trial);
    return edgesValid(outer, inner) ? next : null;
  };

  // First try reaching the pointer's full offset; if that's invalid, bisect for the limit.
  let best = tryAlpha(1);
  if (!best) {
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 6; it++) {
      const mid = (lo + hi) / 2;
      const res = tryAlpha(mid);
      if (res) {
        best = res;
        lo = mid;
      } else {
        hi = mid;
      }
    }
  }
  if (!best) return false;
  if (edge === 'outer') m.outW = best;
  else m.inW = best;
  return true;
}
