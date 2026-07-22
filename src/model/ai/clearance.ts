// Signed clearance raster to the track edges — a cheap "did this move crash" check
// for the AI planner (planner.ts). Pure logic, no DOM.
//
// Why: the exact computeOutcome (game.ts) samples a segment densely and calls
// pointInPolygon against hundreds of vertices at every point — expensive. The A*
// planner only needs to know whether a move crossed a wall, not the exact crash
// point. We precompute a clearance field once per race (like buildNavField), then
// sample it bilinearly in O(1) per lookup.
//
// Signed clearance: on the road it's +distance to the nearest edge; off the road
// it's −(depth past the edge). A move is a crash if clearance anywhere along its
// segment drops below −OFFROAD_FORGIVE (same semantics as scanMove in game.ts).
// Sampling is slightly conservative (a half-cell margin) so a move the planner
// considers safe doesn't actually clip a wall in the real engine due to raster
// coarseness.

import { Vec, distPointToPolyline } from '../../geometry';
import { Track, onRoad } from '../track';
import { OFFROAD_FORGIVE } from '../../config';

/** Raster cell size, in grid units. 0.2 is much smaller than a typical track width
 *  (2..6), so thin barriers and edges are still caught, and memory stays modest (a
 *  few hundred KB per race). */
const CELL = 0.2;
/** Sampling step along a move's segment when checking it (in grid units). Matches
 *  the engine's step (scanMove) so we don't skip over a small corner clip between
 *  samples. */
const STEP = 0.05;
/** Conservative margin added on top of the tolerance, in grid units. Bilinear
 *  sampling near a convex wall corner OVERESTIMATES clearance (the true minimum sits
 *  right at the vertex, between grid nodes) by about CELL/2. We require clearance
 *  with this margin, otherwise the planner could believe in a "fast safe plan" past
 *  an apex that doesn't actually exist in the exact engine, and run into a
 *  speed trap a few moves later. */
const MARGIN = CELL;

export interface Clearance {
  minX: number;
  minY: number;
  cols: number;
  rows: number;
  /** Signed clearance at each grid node (row-major): + on the road, − past the edge. */
  data: Float32Array;
}

/** Signed clearance of a point: + on the road (distance to nearest edge), − past the
 *  edge (depth beyond it). */
function signedClearance(track: Track, p: Vec): number {
  const d = Math.min(
    distPointToPolyline(p, track.outer),
    distPointToPolyline(p, track.inner),
  );
  return onRoad(p, track.outer, track.inner) ? d : -d;
}

/** Build the clearance raster over the outer boundary's bbox (plus a margin). Once
 *  per race. */
export function buildClearance(track: Track): Clearance {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of track.outer) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  // 1-cell margin: a car can legitimately end up within tolerance right at the edge.
  minX -= 1;
  minY -= 1;
  maxX += 1;
  maxY += 1;
  const cols = Math.ceil((maxX - minX) / CELL) + 1;
  const rows = Math.ceil((maxY - minY) / CELL) + 1;
  const data = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      data[r * cols + c] = signedClearance(track, {
        x: minX + c * CELL,
        y: minY + r * CELL,
      });
    }
  }
  return { minX, minY, cols, rows, data };
}

/** Bilinear sampling of clearance at an arbitrary point. Outside the grid, treated
 *  as deep off-road. */
function sample(f: Clearance, x: number, y: number): number {
  const fx = (x - f.minX) / CELL;
  const fy = (y - f.minY) / CELL;
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fy);
  if (c0 < 0 || r0 < 0 || c0 + 1 >= f.cols || r0 + 1 >= f.rows) return -1e3;
  const tx = fx - c0;
  const ty = fy - r0;
  const i = r0 * f.cols + c0;
  const a = f.data[i];
  const b = f.data[i + 1];
  const cc = f.data[i + f.cols];
  const d = f.data[i + f.cols + 1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + cc * (1 - tx) * ty + d * tx * ty;
}

/**
 * Whether the move segment a→b stays clear, never going past the edge deeper than
 * the tolerance. Conservative (half a raster cell of margin): borderline cases count
 * as a crash, so a move planned as "safe" doesn't actually fail in the exact engine.
 */
export function segClear(f: Clearance, a: Vec, b: Vec): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(len / STEP));
  const floor = -OFFROAD_FORGIVE + MARGIN; // engine's tolerance + conservative margin
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (sample(f, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) < floor) return false;
  }
  return true;
}
