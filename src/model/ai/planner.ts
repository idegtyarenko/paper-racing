// A* move planner for the hard bot: searches over (pos, vel) states, minimizing the
// NUMBER OF MOVES to the next forward finish-line crossing. Pure logic, no DOM.
//
// This is what produces a realistic racing line (wide entry → apex → exit) and
// braking before a corner, with no idling or reversing (every move costs +1). Crash
// checking during the search uses the cheap clearance raster (clearance.ts) instead
// of the heavier computeOutcome — that's what makes a deep search feasible within the
// AI_MOVE_DELAY_MS pause.
//
// Opponents are only considered at the first ply (blocked moves are filtered out in
// candidates()): you can't land on or drive through an opponent's cell. Deeper plies
// ignore them since opponents will have moved on by then, and if A*'s optimal cell is
// occupied it just plans around it.

import { Vec, dist, segSegIntersection } from '../../geometry';
import { Track, sideOfFinish } from '../track';
import { GameState, Candidate, WIN_CROSSINGS, computeOutcome } from '../game';
import { NavField, navAt } from '../nav';
import { reachableTargets } from '../turns';
import { Clearance, buildClearance, segClear } from './clearance';
import { PlanParams } from './difficulty';
import { Ranking, OVERSPEED_PENALTY, EPS_MARGIN } from './scoring';

/** Clearance raster is cached per track: built once per race on the hard bot's first
 *  move (hidden behind the pre-move pause), then reused by every car. */
const clearanceCache = new WeakMap<Track, Clearance>();
function clearanceFor(track: Track): Clearance {
  let c = clearanceCache.get(track);
  if (!c) {
    c = buildClearance(track);
    clearanceCache.set(track, c);
  }
  return c;
}

/** Direction of the finish-line crossing for move from→to: +1 forward, −1 backward,
 *  0 none. Same semantics as crossDir in nav.ts (a point exactly on the line counts
 *  as being on the "ahead" side). */
function crossDelta(track: Track, from: Vec, to: Vec): number {
  if (!segSegIntersection(from, to, track.finish.a, track.finish.b)) return 0;
  const sf = sideOfFinish(track, from);
  const st = sideOfFinish(track, to);
  if (sf < 0 && st >= 0) return 1;
  if (sf >= 0 && st < 0) return -1;
  return 0;
}

// ── Min-heap of A* nodes ordered by f, with a deterministic insertion-order tiebreak ──
interface Node {
  pos: Vec;
  vel: Vec;
  g: number; // moves from the start
  f: number; // g + heuristic (h=0 at the goal, so f=g there)
  first: number; // index of the root move this branch grew from
  goal: boolean; // node is a forward finish crossing (a completed plan of length g)
}
class Heap {
  private a: Node[] = [];
  private seq: number[] = [];
  private n = 0;
  private less(i: number, j: number): boolean {
    return this.a[i].f !== this.a[j].f
      ? this.a[i].f < this.a[j].f
      : this.seq[i] < this.seq[j];
  }
  private swap(i: number, j: number): void {
    [this.a[i], this.a[j]] = [this.a[j], this.a[i]];
    [this.seq[i], this.seq[j]] = [this.seq[j], this.seq[i]];
  }
  push(node: Node): void {
    this.a.push(node);
    this.seq.push(this.n++);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): Node | undefined {
    const len = this.a.length;
    if (len === 0) return undefined;
    const top = this.a[0];
    const last = this.a.pop()!;
    const lastSeq = this.seq.pop()!;
    if (len > 1) {
      this.a[0] = last;
      this.seq[0] = lastSeq;
      let i = 0;
      const size = this.a.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < size && this.less(l, m)) m = l;
        if (r < size && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  get size(): number {
    return this.a.length;
  }
}

/** Ranks the root moves via the A* planner (used by all difficulty levels). */
export function scoreByPlan(
  state: GameState,
  nav: NavField,
  open: Candidate[],
  plan: PlanParams,
  maxSpeed: number,
  stopCap: number,
  enforceStop: boolean,
): Ranking {
  const { track, rules } = state;
  const drive = rules.drive;
  const me = state.players[state.current];
  const cl = clearanceFor(track);

  // Exact outcome of the first move for each candidate: root moves are actually
  // executed, so we trust the real engine for their crash/crossing check (≤9 calls,
  // cheap) rather than the raster — the raster's coarser resolution is fine for
  // interior search nodes that never get executed. This guarantees the bot's actual
  // move is never a crash.
  const rootOutcome = open.map((c) => computeOutcome(track, rules, me.pos, c.target));

  // A winning move beats everything else — pick the one that carries furthest past
  // the line (tiebreak for the final lap), preferring a crash-free one on ties.
  let win: Candidate | null = null;
  let winKey = -Infinity;
  open.forEach((c, i) => {
    const o = rootOutcome[i];
    if (me.crossings + o.crossingDelta >= WIN_CROSSINGS) {
      const key = sideOfFinish(track, o.end) + (o.crash ? -1e3 : 0);
      if (key > winKey) {
        winKey = key;
        win = c;
      }
    }
  });
  if (win) return { best: win, terminal: true, scored: [] };

  // Raster-based safety invariant: from state (pos, vel) the car can brake to a full
  // stop without ever crashing (within cap moves; at the recursion limit we
  // optimistically assume it'll manage). Without this check, A* — which only
  // minimizes move count — would happily accelerate into a dead end at a distant
  // corner whenever the budget runs out before reaching the finish and the greedy
  // fallback kicks in. It's cheap (raster-based), so we check it on every root move.
  const stopMemo = new Map<string, boolean>();
  const canStop = (pos: Vec, vel: Vec, cap: number): boolean => {
    if (vel.x === 0 && vel.y === 0) return true;
    if (cap <= 0) return true;
    const key = `${pos.x},${pos.y},${vel.x},${vel.y},${cap}`;
    const hit = stopMemo.get(key);
    if (hit !== undefined) return hit;
    // Try the hardest-braking options first — finds a chain down to zero faster.
    const opts = reachableTargets(pos, vel, drive).sort(
      (A, B) =>
        Math.hypot(A.x - pos.x, A.y - pos.y) - Math.hypot(B.x - pos.x, B.y - pos.y),
    );
    let ok = false;
    for (const t of opts) {
      if (crossDelta(track, pos, t) === -1 || !segClear(cl, pos, t)) continue;
      if (canStop(t, { x: t.x - pos.x, y: t.y - pos.y }, cap - 1)) {
        ok = true;
        break;
      }
    }
    stopMemo.set(key, ok);
    return ok;
  };

  // Root candidates are moves that don't crash (per the engine) and don't cross the
  // finish backward. Prefer ones from which we can guarantee braking to a stop (the
  // safety invariant); if none are safe, fall back to any non-crashing move (not
  // crashing beats crashing).
  const noCrash: number[] = [];
  open.forEach((c, i) => {
    if (!rootOutcome[i].crash && rootOutcome[i].crossingDelta !== -1) noCrash.push(i);
  });
  // enforceStop: prefer roots that are guaranteed to be able to stop (medium/hard
  // drive clean). easy (enforceStop=false) drives on the edge — it accepts any
  // non-crashing move and occasionally fails to brake in time → crash (intentional
  // "liveliness" for the weak difficulty level).
  const safe = enforceStop
    ? noCrash.filter((i) => {
        const o = rootOutcome[i];
        return o.crossingDelta === 1 || canStop(o.end, o.vel, stopCap);
      })
    : noCrash;
  const rootIdx = safe.length > 0 ? safe : noCrash;
  // Every move crashes: pick the one with the smallest idle penalty.
  if (rootIdx.length === 0) {
    let best = open[0];
    let bestSkip = Infinity;
    open.forEach((c, i) => {
      if (rootOutcome[i].skipTurns < bestSkip) {
        bestSkip = rootOutcome[i].skipTurns;
        best = c;
      }
    });
    return { best, terminal: true, scored: [] };
  }

  const overspeed = (from: Vec, to: Vec): number => {
    const sp = dist(from, to);
    return sp > maxSpeed ? (sp - maxSpeed) * OVERSPEED_PENALTY : 0;
  };
  const hMemo = new Map<number, number>();
  const h = (p: Vec): number => {
    const k = (p.x + 512) * 4096 + (p.y + 512);
    let v = hMemo.get(k);
    if (v === undefined) {
      v = (plan.weight * navAt(nav, p)) / plan.vref;
      hMemo.set(k, v);
    }
    return v;
  };

  const heap = new Heap();
  const closed = new Map<string, number>(); // (pos, vel) state → best g so far
  const sk = (p: Vec, v: Vec) => `${p.x},${p.y},${v.x},${v.y}`;
  const push = (pos: Vec, vel: Vec, g: number, first: number, goal: boolean) => {
    heap.push({ pos, vel, g, f: goal ? g : g + h(pos), first, goal });
  };

  // Seed the frontier with the root moves. A root that immediately crosses the
  // finish is a goal of length 1.
  for (const i of rootIdx) {
    const target = open[i].target;
    const g = 1 + overspeed(me.pos, target);
    if (rootOutcome[i].crossingDelta === 1) {
      push(target, { x: 0, y: 0 }, g, i, true);
    } else {
      const vel = { x: target.x - me.pos.x, y: target.y - me.pos.y };
      push(target, vel, g, i, false);
      closed.set(sk(target, vel), g);
    }
  }

  // Plan cost per root: the min length of a completed plan starting from that root.
  const rootPlan = new Map<number, number>();
  let bestPlan = Infinity;
  let fallbackFirst = rootIdx[0];
  let fallbackF = Infinity;
  let exp = 0;
  while (heap.size > 0 && exp < plan.budget) {
    const cur = heap.pop()!;
    if (cur.goal) {
      // Goals are popped in increasing order of f=g, so this is optimal. We collect
      // roots whose plan falls within EPS of the best one (for jostling among near-
      // ties), then can stop once we're past that margin.
      if (cur.g < bestPlan) bestPlan = cur.g;
      const prev = rootPlan.get(cur.first);
      if (prev === undefined || cur.g < prev) rootPlan.set(cur.first, cur.g);
      if (cur.f > bestPlan + EPS_MARGIN) break;
      continue;
    }
    if ((closed.get(sk(cur.pos, cur.vel)) ?? Infinity) < cur.g) continue;
    if (cur.f < fallbackF) {
      fallbackF = cur.f;
      fallbackFirst = cur.first;
    }
    exp++;
    for (const target of reachableTargets(cur.pos, cur.vel, drive)) {
      const cd = crossDelta(track, cur.pos, target);
      if (cd === -1) continue; // never drive backward through the finish
      const g = cur.g + 1 + overspeed(cur.pos, target);
      if (cd === 1) {
        push(target, { x: 0, y: 0 }, g, cur.first, true);
        continue;
      }
      if (!segClear(cl, cur.pos, target)) continue;
      const vel = { x: target.x - cur.pos.x, y: target.y - cur.pos.y };
      const key = sk(target, vel);
      const prev = closed.get(key);
      if (prev !== undefined && prev <= g) continue;
      closed.set(key, g);
      push(target, vel, g, cur.first, false);
    }
  }

  // The optimal root is the one with the minimal exact plan length (ties broken by
  // lower index, for determinism). If no plan reached the finish within budget, fall
  // back to the frontier branch with the smallest f.
  let bestFirst = fallbackFirst;
  if (rootPlan.size > 0) {
    let bestLen = Infinity;
    rootPlan.forEach((len, i) => {
      if (len < bestLen) {
        bestLen = len;
        bestFirst = i;
      }
    });
  }

  // Pool used for jostling among near-ties: a root with an exact plan gets its
  // length; a root without one (its branches merged into `closed` or never reached
  // the finish) gets a lower-bound estimate of 1 + navAt/vref in the same "moves"
  // unit, so that reasonable forward moves still make it into the pool (otherwise
  // A* is too decisive, the pool stays thin, and bots end up bunching together).
  // Crashing/backward moves get a large penalty and are excluded from the pool.
  const rootSet = new Set(rootIdx);
  const scored = open.map((c, i) => {
    if (!rootSet.has(i)) return { c, score: 1e5 };
    const pl = rootPlan.get(i);
    if (pl !== undefined) return { c, score: pl };
    return { c, score: 1 + navAt(nav, c.target) / plan.vref };
  });
  return { best: open[bestFirst], terminal: false, scored };
}
