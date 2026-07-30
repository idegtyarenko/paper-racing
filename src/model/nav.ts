// Track navigation field: distances to the finish over road nodes (BFS,
// 8-connectivity). Originally built for the AI (see ai.ts), but also used by
// the standings board (standings.ts) as an estimate of "how far is there still
// left to the finish", so it lives in its own module. Pure logic, no DOM.
//
// dist(cell) = number of steps at speed 1 to the next forward crossing of the
// finish line. In the BFS, the finish line acts as a "wall" (edges don't pass
// through it), except for the final hop from seed cells: that way cells right
// behind the line get roughly a full lap's distance "the long way around", and
// it's always in the car's interest to keep driving forward.

import { Vec, dist, lerp, segSegIntersection } from '../geometry';
import { Track, key, unkey, sideOfFinish } from './track';
import { offRoadDepth } from './game';
import { OFFROAD_FORGIVE, CRASH_SAMPLE_STEP } from '../config';

/** Field of distances to the finish over road nodes. */
export interface NavField {
  /** key(x,y) -> steps (at speed 1) to the next forward finish crossing. */
  dist: Map<number, number>;
  /** ~ lap length in steps: max finite dist + 1. Added for a lap not yet completed. */
  lap: number;
  /** The field's track — used for which side of the finish navAt is on (the search window must not look across the line). */
  track: Track;
}

/**
 * Direction of a finish crossing along edge u->v: +1 forward, -1 backward, 0
 * none. Same semantics as computeOutcome: a point exactly on the line counts as
 * the "ahead" side, so a single crossing never gets counted twice.
 */
function crossDir(track: Track, u: Vec, v: Vec): number {
  if (!segSegIntersection(u, v, track.finish.a, track.finish.b)) return 0;
  const su = sideOfFinish(track, u);
  const sv = sideOfFinish(track, v);
  if (su < 0 && sv >= 0) return 1;
  if (su >= 0 && sv < 0) return -1;
  return 0;
}

/**
 * Whether an edge is traversable: it doesn't stray past the edge tolerance
 * anywhere along its length. Rules out diagonals and edges that "tunnel"
 * through a thin grass strip between two passes of the track (otherwise the
 * field would steer bots into an impossible shortcut).
 *
 * Sampled at the engine's own step. Checking the midpoint alone was too coarse:
 * an edge can clip a thin wall off-centre while its midpoint sits squarely on
 * the road (a real case: (141,122)->(142,123) has midpoint depth 0.000 but goes
 * 0.195 past the edge a third of the way along, at a tolerance of 0.05). The
 * field then leaks into a neighbouring pass of the track, and the bot follows
 * that phantom gradient into a pinch it physically can't drive through and
 * parks there.
 */
function edgeOk(track: Track, u: Vec, v: Vec): boolean {
  return segOnRoad(track, u, v);
}

/** Build the field of distances to the finish. Computed once per race. */
export function buildNavField(track: Track): NavField {
  const d = new Map<number, number>();
  const queue: Vec[] = [];

  // Seeds: cells behind the line from which a single step crosses the finish forward.
  track.inside.forEach((k) => {
    const u = unkey(k);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const v = { x: u.x + dx, y: u.y + dy };
        if (!track.inside.has(key(v.x, v.y))) continue;
        if (crossDir(track, u, v) === 1 && edgeOk(track, u, v)) {
          d.set(k, 1);
          queue.push(u);
          return;
        }
      }
    }
  });

  // BFS backward over edges that don't cross the finish: cells "ahead" of the
  // line get their distance via the long way around the lap.
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    const du = d.get(key(u.x, u.y))!;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const w = { x: u.x + dx, y: u.y + dy };
        const wk = key(w.x, w.y);
        if (d.has(wk) || !track.inside.has(wk)) continue;
        if (crossDir(track, w, u) !== 0 || !edgeOk(track, w, u)) continue;
        d.set(wk, du + 1);
        queue.push(w);
      }
    }
  }

  let lap = 0;
  d.forEach((v) => {
    lap = Math.max(lap, v);
  });
  return { dist: d, lap: lap + 1, track };
}

/**
 * Whether segment a->b lies entirely on the road (within tolerance). Same
 * criterion — and the same sampling step — the engine uses in scanMove: samples
 * don't stray past OFFROAD_FORGIVE beyond the edge. The step used to be 0.5,
 * which only caught grass strips a full cell or so wide; a wall that the ray
 * clips for a few tenths of a cell slipped between samples, and navAt then
 * reported a neighbouring pass's distance (8.6 instead of the honest 26).
 */
function segOnRoad(track: Track, a: Vec, b: Vec): boolean {
  const steps = Math.max(1, Math.ceil(dist(a, b) / CRASH_SAMPLE_STEP));
  for (let i = 1; i < steps; i++) {
    if (offRoadDepth(track, lerp(a, b, i / steps)) > OFFROAD_FORGIVE) return false;
  }
  return true;
}

/**
 * Distance to the finish for an arbitrary point — not necessarily a road node
 * (a crash point has fractional coordinates; a legal move can end within the
 * tolerance band or closer than WALL_CLEARANCE to a wall, where there are no
 * nodes in inside). We take the minimum of dist plus the Euclidean remainder
 * over the cells in a +-3 window; if nothing is found in that window at all
 * (deep in the gravel), we conservatively return a full lap length.
 */
export function navAt(field: NavField, p: Vec): number {
  const cx = Math.round(p.x);
  const cy = Math.round(p.y);
  // Collect the window's cells with their estimates, then validate them in
  // increasing order of estimate and take the first one that survives. Same
  // answer as scanning the whole window (the minimum over valid cells), but the
  // expensive ray checks below usually run once instead of up to 49 times.
  const cands: { c: Vec; est: number }[] = [];
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const c = { x: cx + dx, y: cy + dy };
      const v = field.dist.get(key(c.x, c.y));
      if (v === undefined) continue;
      cands.push({ c, est: v + dist(p, c) });
    }
  }
  cands.sort((a, b) => a.est - b.est);
  for (const { c, est } of cands) {
    // A cell on the other side of the finish line doesn't count: its distance
    // reflects a different number of crossings remaining (otherwise the
    // potential collapses right at the line, and the bot "sticks" to it
    // instead of running an honest lap).
    if (crossDir(field.track, p, c) !== 0) continue;
    // The ray p->c must not cut through a wall: otherwise the field "leaks"
    // into a neighboring pass of the track through a thin strip, and the bot
    // drives straight into it.
    if (!segOnRoad(field.track, p, c)) continue;
    return est;
  }
  // Nothing valid in the window at all (deep in the gravel) — conservatively a
  // full lap length.
  return field.lap;
}
