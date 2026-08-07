// Lanes for overlapping trails.
//
// Cars that drive the same racing line paint the same pixels, so only the last
// one drawn stays visible. The fix is the transit-map trick: where routes
// coincide, spread them into parallel lanes. The important part is "where" —
// offsetting a whole trail displaces cars that never met (six cars leaving the
// starting grid each sit on their own row, and shifting all of them just
// smears the picture). So the offset is computed per stretch of path: zero
// wherever a car is alone, a lane only where it actually shares a line.
//
// The result is a piecewise-LINEAR, continuous offset along each trail. That
// continuity is the whole ballgame for rendering: the ribbon is built from the
// offset positions, so any jump in this function would tear a visible gap.
// Transitions therefore ramp over `ramp` cells instead of stepping, and every
// chain returns to the true path at its free ends, where the car marker, the
// crash mark, and the start node live.

import { TrailSeg } from '../model/game';

/** Sideways offset at one point along a segment. */
export interface LaneStop {
  /** Position along the segment: 0 at `from`, 1 at `to`. */
  t: number;
  /** Offset in CELLS along the segment's left normal (−dy, dx). */
  offset: number;
}

export interface LaneOpts {
  /** Distance between neighbouring lanes, in cells. */
  step?: number;
  /** Hard cap on the spread between the outermost lanes, in cells. */
  maxSpread?: number;
  /** Distance over which the offset ramps between two values, in cells. */
  ramp?: number;
}

/**
 * The geometry the renderer draws with — kept here rather than at the call site
 * so the numbers the tests measure against are the numbers that ship.
 *
 * Everything is in CELLS, so the bundle scales with zoom (and honestly vanishes
 * when zoomed far out, which is fine — so does every other detail). `step` is
 * the width of one trail at full speed and no more: neighbouring lanes touch
 * like lines on a transit map, which is what makes a shared line read as a
 * bundle of routes rather than a smear. `maxSpread` fits a full starting grid
 * (six cars = five gaps) without squeezing it, and still keeps the outermost
 * trail close enough to read as "through this node".
 */
export const LANE_DEFAULTS = {
  step: 0.13,
  maxSpread: 0.65,
  ramp: 0.5,
} as const;

const EPS = 1e-9;

/** Quantized component for the line bucket key; normalizes −0 to 0. */
const q = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return (r === 0 ? 0 : r).toFixed(3);
};

const segLen = (s: TrailSeg): number => Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y);

/** One drawable segment, projected onto its supporting line's axis. */
interface Proj {
  pi: number;
  si: number;
  ta: number;
  tb: number;
}

/** A constant-offset stretch of one segment, in local t. */
interface Piece {
  t0: number;
  t1: number;
  offset: number;
}

/** A constant-offset stretch of one chain, in arc length. */
interface Run {
  s0: number;
  s1: number;
  o: number;
}

/**
 * Lane offsets for every segment of every trail, as `[player][segment]` lists
 * of stops. Each list has at least `t: 0` and `t: 1`; between stops the offset
 * interpolates linearly. Segments that need no offset get plain zeros.
 *
 * Only overlaps between DIFFERENT players count — a car sharing a line with
 * itself is the same colour anyway, and with a single lap it barely happens.
 */
export function computeLanes(trails: TrailSeg[][], opts: LaneOpts = {}): LaneStop[][][] {
  const step = opts.step ?? LANE_DEFAULTS.step;
  const maxSpread = opts.maxSpread ?? LANE_DEFAULTS.maxSpread;
  const ramp = opts.ramp ?? LANE_DEFAULTS.ramp;

  const out: LaneStop[][][] = trails.map((t) =>
    t.map(() => [
      { t: 0, offset: 0 },
      { t: 1, offset: 0 },
    ]),
  );

  // --- 1. Bucket segments by their supporting line. Node coordinates are
  // integers for ordinary moves, so equal lines produce byte-identical keys;
  // crash points are floats, hence the quantization.
  const buckets = new Map<string, Proj[]>();
  trails.forEach((trail, pi) =>
    trail.forEach((seg, si) => {
      if (seg.jump) return;
      const dx = seg.to.x - seg.from.x;
      const dy = seg.to.y - seg.from.y;
      const len = Math.hypot(dx, dy);
      if (len < EPS) return;
      // Unit normal, sign canonicalized so that a line and its reverse land in
      // the same bucket.
      let nx = -dy / len;
      let ny = dx / len;
      if (nx < -EPS || (Math.abs(nx) <= EPS && ny < 0)) {
        nx = -nx;
        ny = -ny;
      }
      const c = nx * seg.from.x + ny * seg.from.y;
      const key = `${q(nx)}|${q(ny)}|${q(c)}`;
      // Axis along the line, derived from the canonical normal so every
      // member of the bucket is projected onto the same parameterization.
      const ax = ny;
      const ay = -nx;
      const arr = buckets.get(key) ?? [];
      if (arr.length === 0) buckets.set(key, arr);
      arr.push({
        pi,
        si,
        ta: ax * seg.from.x + ay * seg.from.y,
        tb: ax * seg.to.x + ay * seg.to.y,
      });
    }),
  );

  // --- 2. Sweep each bucket: on every elementary interval, hand out lanes to
  // the players present there.
  const pieces = new Map<string, Piece[]>();
  for (const segs of buckets.values()) {
    if (segs.length < 2) continue;
    const bounds = new Set<number>();
    for (const s of segs) {
      bounds.add(Math.min(s.ta, s.tb));
      bounds.add(Math.max(s.ta, s.tb));
    }
    const marks = [...bounds].sort((a, b) => a - b);
    for (let i = 0; i + 1 < marks.length; i++) {
      const lo = marks[i];
      const hi = marks[i + 1];
      if (hi - lo < EPS) continue;
      const mid = (lo + hi) / 2;
      const here = segs.filter(
        (s) => Math.min(s.ta, s.tb) < mid && mid < Math.max(s.ta, s.tb),
      );
      const players = [...new Set(here.map((s) => s.pi))].sort((a, b) => a - b);
      if (players.length < 2) continue;
      const m = players.length;
      // Squeezing the lanes keeps a six-car pile-up from spanning a full cell.
      const stepEff = Math.min(step, maxSpread / (m - 1));
      for (const s of here) {
        const offset = (players.indexOf(s.pi) - (m - 1) / 2) * stepEff;
        if (Math.abs(offset) < EPS) continue;
        const ta = (lo - s.ta) / (s.tb - s.ta);
        const tb = (hi - s.ta) / (s.tb - s.ta);
        const key = `${s.pi}:${s.si}`;
        const arr = pieces.get(key) ?? [];
        if (arr.length === 0) pieces.set(key, arr);
        arr.push({ t0: Math.min(ta, tb), t1: Math.max(ta, tb), offset });
      }
    }
  }

  // --- 3. Walk each trail in chains, turning the per-segment pieces into one
  // continuous, ramped offset function per chain.
  trails.forEach((trail, pi) => {
    let i = 0;
    while (i < trail.length) {
      if (trail[i].jump || segLen(trail[i]) < EPS) {
        i++;
        continue;
      }
      let j = i + 1;
      while (
        j < trail.length &&
        !trail[j].jump &&
        segLen(trail[j]) >= EPS &&
        trail[j].from.x === trail[j - 1].to.x &&
        trail[j].from.y === trail[j - 1].to.y
      ) {
        j++;
      }
      resolveChain(trail, pi, i, j, pieces, out[pi], ramp);
      i = j;
    }
  });

  return out;
}

/** Ramp and resample one chain of connected segments `[i0, i1)`. */
function resolveChain(
  trail: TrailSeg[],
  pi: number,
  i0: number,
  i1: number,
  pieces: Map<string, Piece[]>,
  out: LaneStop[][],
  ramp: number,
): void {
  const starts: number[] = [];
  const lens: number[] = [];
  let total = 0;
  for (let k = i0; k < i1; k++) {
    starts.push(total);
    const l = segLen(trail[k]);
    lens.push(l);
    total += l;
  }

  // Piecewise-constant offset over the chain's arc length.
  const runs: Run[] = [];
  for (let k = i0; k < i1; k++) {
    const s0 = starts[k - i0];
    const l = lens[k - i0];
    const list = (pieces.get(`${pi}:${k}`) ?? []).slice().sort((a, b) => a.t0 - b.t0);
    let t = 0;
    for (const p of list) {
      if (p.t0 > t + EPS) runs.push({ s0: s0 + t * l, s1: s0 + p.t0 * l, o: 0 });
      runs.push({ s0: s0 + Math.max(t, p.t0) * l, s1: s0 + p.t1 * l, o: p.offset });
      t = p.t1;
    }
    if (t < 1 - EPS) runs.push({ s0: s0 + t * l, s1: s0 + l, o: 0 });
  }
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.o - r.o) < EPS) last.s1 = r.s1;
    else merged.push({ ...r });
  }

  // Control points. Ramps are half-width on each side of a boundary and never
  // longer than half of either neighbouring run, so consecutive ramps can
  // touch but never cross — which keeps the sequence monotone in `s`.
  const cps: { s: number; o: number }[] = [];
  const push = (s: number, o: number): void => {
    const last = cps[cps.length - 1];
    if (last && s <= last.s + EPS) {
      last.o = o;
      return;
    }
    cps.push({ s, o });
  };
  const half = ramp / 2;
  const runLen = (r: Run): number => r.s1 - r.s0;

  push(0, 0);
  if (Math.abs(merged[0].o) > EPS) {
    push(Math.min(ramp, runLen(merged[0]) / 2), merged[0].o);
  }
  for (let k = 0; k + 1 < merged.length; k++) {
    const r = Math.min(half, runLen(merged[k]) / 2, runLen(merged[k + 1]) / 2);
    push(merged[k].s1 - r, merged[k].o);
    push(merged[k].s1 + r, merged[k + 1].o);
  }
  const lastRun = merged[merged.length - 1];
  if (Math.abs(lastRun.o) > EPS) {
    push(total - Math.min(ramp, runLen(lastRun) / 2), lastRun.o);
  }
  push(total, 0);

  const offsetAt = (s: number): number => {
    if (s <= cps[0].s) return cps[0].o;
    for (let k = 1; k < cps.length; k++) {
      if (s <= cps[k].s) {
        const a = cps[k - 1];
        const b = cps[k];
        const d = b.s - a.s;
        return d <= EPS ? b.o : a.o + ((b.o - a.o) * (s - a.s)) / d;
      }
    }
    return cps[cps.length - 1].o;
  };

  // Back to per-segment stops. Both sides of a shared node read the same
  // control-point function at the same arc position, so the offset matches
  // exactly and the ribbon cannot come apart.
  for (let k = i0; k < i1; k++) {
    const s0 = starts[k - i0];
    const l = lens[k - i0];
    const stops: LaneStop[] = [{ t: 0, offset: offsetAt(s0) }];
    for (const cp of cps) {
      if (cp.s > s0 + EPS && cp.s < s0 + l - EPS) {
        stops.push({ t: (cp.s - s0) / l, offset: cp.o });
      }
    }
    stops.push({ t: 1, offset: offsetAt(s0 + l) });
    out[k] = stops;
  }
}

/**
 * The lane stops of a segment cut short at `u` (0..1 of its length), rescaled to
 * the shorter segment's own 0..1. Used when a car is mid-segment — during the
 * replay or the post-move tween the trail is drawn only as far as the car has
 * got, and its lane has to end where the car is, not where the move ends.
 */
export function clipLaneStops(stops: LaneStop[], u: number): LaneStop[] {
  if (u >= 1 || stops.length === 0) return stops;
  if (u <= 0) return [{ t: 0, offset: stops[0].offset }];
  const offsetAt = (t: number): number => {
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i].t) {
        const a = stops[i - 1];
        const b = stops[i];
        const d = b.t - a.t;
        return d <= EPS ? b.offset : a.offset + ((b.offset - a.offset) * (t - a.t)) / d;
      }
    }
    return stops[stops.length - 1].offset;
  };
  const out = stops
    .filter((st) => st.t < u)
    .map((st) => ({ t: st.t / u, offset: st.offset }));
  out.push({ t: 1, offset: offsetAt(u) });
  return out;
}
