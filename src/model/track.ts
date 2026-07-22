// Track model: processing drawn strokes, validation, finalization.

import {
  Vec,
  Polyline,
  add,
  sub,
  dot,
  dist,
  lerp,
  scale,
  normalize,
  pointInPolygon,
  distPointToPolyline,
  distPointToSegment,
  segmentPolylineIntersections,
  resampleClosed,
  chaikinClosed,
  trimSeamOverlap,
} from '../geometry';
import { strings } from '../i18n';
import {
  WORLD_SIZE,
  WALL_CLEARANCE,
  MAX_START_POINTS,
  MIN_ROAD_CELLS,
  START_ROW_MAX,
  START_REGION_DEPTH,
  START_SEED_TOL,
} from '../config';

export interface FinishLine {
  a: Vec;
  b: Vec;
}

export interface Track {
  outer: Polyline;
  inner: Polyline;
  finish: FinishLine;
  /** Unit normal of the finish line, pointing in the direction of the race. */
  forward: Vec;
  /** Grid nodes that lie on the road (keys — see key()). */
  inside: Set<number>;
  /** Starting nodes, strictly behind the finish line (closest to it come first). */
  startPoints: Vec[];
}

const KEY_OFFSET = 128;

export const key = (x: number, y: number): number =>
  (x + KEY_OFFSET) * 4096 + (y + KEY_OFFSET);

export const unkey = (k: number): Vec => ({
  x: Math.floor(k / 4096) - KEY_OFFSET,
  y: (k % 4096) - KEY_OFFSET,
});

export type StrokeResult = { poly: Polyline } | { error: string };

/** Closing, resampling, and smoothing a raw freehand stroke. */
export function processStroke(raw: Vec[]): StrokeResult {
  if (raw.length < 8) {
    return { error: strings.track.strokeShort };
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of raw) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (diag < 4) {
    return { error: strings.track.strokeShort };
  }
  if (dist(raw[0], raw[raw.length - 1]) > 0.25 * diag) {
    return { error: strings.track.notClosed };
  }
  const maxTrim = Math.max(2, 0.12 * diag); // threshold for a "minor" overlap of the endpoints
  const closed = trimSeamOverlap(raw, maxTrim);
  let poly = resampleClosed(closed, 0.5);
  poly = chaikinClosed(poly, 2);
  poly = resampleClosed(poly, 0.5);
  return { poly };
}

/** Whether a point (not necessarily a grid node) lies on the road between the edges. */
export function onRoad(p: Vec, outer: Polyline, inner: Polyline): boolean {
  return pointInPolygon(p, outer) && !pointInPolygon(p, inner);
}

function isRoadLatticePoint(p: Vec, outer: Polyline, inner: Polyline): boolean {
  return (
    onRoad(p, outer, inner) &&
    distPointToPolyline(p, outer) > WALL_CLEARANCE &&
    distPointToPolyline(p, inner) > WALL_CLEARANCE
  );
}

/**
 * Builds the finish line from the user's drag: the line is extended in both
 * directions, and among its intersections with the edges we take the road
 * segment containing the midpoint of the drag. The endpoints are pushed 0.25
 * cells past the walls to close numerical gaps. The drag doesn't need to run
 * exactly from wall to wall — it just needs to indicate a direction across the road.
 */
export type ClipFinishResult = { finish: FinishLine } | { error: 'no-cross' | 'narrow' };

export function clipFinishLine(
  a: Vec,
  b: Vec,
  outer: Polyline,
  inner: Polyline,
): ClipFinishResult {
  const d = normalize(sub(b, a));
  if (d.x === 0 && d.y === 0) return { error: 'no-cross' };
  const EXT = 200;
  const A = sub(a, scale(d, EXT));
  const B = add(b, scale(d, EXT));
  const hits = [
    ...segmentPolylineIntersections(A, B, outer),
    ...segmentPolylineIntersections(A, B, inner),
  ].sort((x, y) => x.t - y.t);
  const mid = lerp(a, b, 0.5);
  const tMid = dot(sub(mid, A), d) / dist(A, B);
  for (let i = 0; i + 1 < hits.length; i++) {
    if (hits[i].t <= tMid && tMid <= hits[i + 1].t) {
      const p1 = hits[i].point;
      const p2 = hits[i + 1].point;
      // Midpoint of the segment between adjacent intersections falls off the
      // road — the line runs through a "gap" (missing the road), not across it.
      if (!onRoad(lerp(p1, p2, 0.5), outer, inner)) return { error: 'no-cross' };
      // The road is crossed correctly, but is too narrow at this spot.
      if (dist(p1, p2) < 1) return { error: 'narrow' };
      return { finish: { a: sub(p1, scale(d, 0.25)), b: add(p2, scale(d, 0.25)) } };
    }
  }
  return { error: 'no-cross' };
}

/** Signed distance from a point to the finish line, along the direction of the race. */
export function sideOfFinish(track: Pick<Track, 'finish' | 'forward'>, p: Vec): number {
  return dot(sub(p, track.finish.a), track.forward);
}

/** Starting candidate: a node behind the finish plus its corridor depth (BFS
 *  steps back from the line, computed in finalizeTrack). */
export interface StartCandidate {
  p: Vec;
  corridor: number;
}

/**
 * Starting grid: from the nodes behind the finish, picks up to MAX_START_POINTS
 * points, laid out in rows along the corridor going back from the line. A "row"
 * is one layer of corridor depth (BFS steps from the line): on a straight this
 * is a column of nodes behind the line, on a turn it's an arc following the
 * curve of the road. Each row fills from the center of the track outward up to
 * START_ROW_MAX cars; anything that doesn't fit spills into the next (deeper)
 * layer. The goal is minimum depth for a centered start: nobody stands off to
 * the side against a wall (a side start is sometimes an advantage, sometimes
 * not — we're eliminating that noise), and extra depth only appears once there
 * are more cars than fit across the central band.
 *
 * Candidates are consumed strictly in order of increasing corridor depth, so a
 * distant node on a far-off part of the track (large depth) can never get
 * picked while closer ones remain: the grid is always a tight cluster right
 * behind the line, even where the road bends sharply just past the finish.
 * Lateral centering uses the finish line's own axis, latUnit (reliable at the
 * shallow depths where cars actually end up). Returns points in order of
 * increasing depth (the first is pole); with fewer players, newGame just takes
 * the front slots (the first row on the line), so 2-3 cars start with no depth at all.
 */
export function layoutStartGrid(
  finish: FinishLine,
  forward: Vec,
  behind: StartCandidate[],
): Vec[] {
  const M = lerp(finish.a, finish.b, 0.5);
  const latUnit = normalize(sub(finish.b, finish.a)); // lateral axis (along the line)
  const cand = behind.map((c) => ({
    p: c.p,
    corridor: c.corridor,
    lat: dot(sub(c.p, M), latUnit),
  }));
  // Pole first, center first: closest along the corridor to the line first, then closest to center.
  cand.sort(
    (a, b) =>
      a.corridor - b.corridor ||
      Math.abs(a.lat) - Math.abs(b.lat) ||
      a.p.y - b.p.y ||
      a.p.x - b.p.x,
  );

  const picked = new Set<(typeof cand)[number]>();
  const perRow = new Map<number, number>();
  // Pass 1: up to START_ROW_MAX central nodes per corridor layer, shallower
  // layers first; an overfull row "spills over" into the next (deeper) layer.
  for (const c of cand) {
    if (picked.size >= MAX_START_POINTS) break;
    const n = perRow.get(c.corridor) ?? 0;
    if (n >= START_ROW_MAX) continue;
    perRow.set(c.corridor, n + 1);
    picked.add(c);
  }
  // Pass 2 (a fallback; only for degenerate single-layer strips where there isn't
  // enough depth to fit MAX_START_POINTS in rows of <= START_ROW_MAX): fill in the
  // rest in the same order.
  if (picked.size < MAX_START_POINTS) {
    for (const c of cand) {
      if (picked.size >= MAX_START_POINTS) break;
      picked.add(c);
    }
  }

  // Front-to-back order: pole (index 0) is closest to the line along the
  // corridor, with row centers first. With fewer players, newGame just takes the
  // first n; the permutation itself is arbitrary.
  return [...picked]
    .sort(
      (a, b) =>
        a.corridor - b.corridor ||
        Math.abs(a.lat) - Math.abs(b.lat) ||
        a.p.y - b.p.y ||
        a.p.x - b.p.x,
    )
    .map((c) => c.p);
}

export type FinalizeResult = { track: Track } | { error: string };

export function finalizeTrack(
  outer: Polyline,
  inner: Polyline,
  finish: FinishLine,
  forward: Vec,
): FinalizeResult {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of outer) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const x0 = Math.max(0, Math.floor(minX));
  const x1 = Math.min(WORLD_SIZE, Math.ceil(maxX));
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(WORLD_SIZE, Math.ceil(maxY));

  const inside = new Set<number>();
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (isRoadLatticePoint({ x, y }, outer, inner)) inside.add(key(x, y));
    }
  }
  if (inside.size < MIN_ROAD_CELLS) {
    return { error: strings.track.tooNarrow };
  }

  // Starting candidates aren't the whole "behind the finish" half-plane (on an
  // S-curve that catches distant segments of the track too, and the grid's
  // fallback fill could then seat a car in the middle of the lap) — instead it's
  // the connected corridor right behind the line: BFS going back from nodes
  // touching the line from behind, restricted to "backward" road nodes, with a
  // depth cap.
  const isBehind = (p: Vec): boolean => sideOfFinish({ finish, forward }, p) < -1e-9;
  const behind: StartCandidate[] = [];
  const depth = new Map<number, number>();
  const queue: Vec[] = [];
  const NB8 = [
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, -1],
    [0, 1],
    [1, -1],
    [1, 0],
    [1, 1],
  ];
  // Seed: backward road nodes right up against the finish SEGMENT (not the
  // infinite line — that would also cut through other segments of an S-curve;
  // anchoring to the segment keeps the region from sprouting out of a distant
  // intersection).
  inside.forEach((k) => {
    const p = unkey(k);
    if (!isBehind(p)) return;
    if (distPointToSegment(p, finish.a, finish.b) <= START_SEED_TOL) {
      depth.set(k, 0);
      queue.push(p);
      behind.push({ p, corridor: 0 });
    }
  });
  // Wavefront going deeper into the corridor over backward road nodes; nodes
  // right at the depth boundary are kept, but the region doesn't grow past them.
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head];
    const d = depth.get(key(p.x, p.y))!;
    if (d >= START_REGION_DEPTH) continue;
    for (const [dx, dy] of NB8) {
      const q = { x: p.x + dx, y: p.y + dy };
      const qk = key(q.x, q.y);
      if (depth.has(qk) || !inside.has(qk) || !isBehind(q)) continue;
      depth.set(qk, d + 1);
      queue.push(q);
      behind.push({ p: q, corridor: d + 1 });
    }
  }
  if (behind.length < 2) {
    return { error: strings.track.noStartRoom };
  }
  return {
    track: {
      outer,
      inner,
      finish,
      forward,
      inside,
      startPoints: layoutStartGrid(finish, forward, behind),
    },
  };
}
