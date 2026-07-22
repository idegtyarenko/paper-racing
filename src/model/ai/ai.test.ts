// AI tests: navigation field (BFS to the finish) and the bot's move selection.
//
// The track is the same rectangular ring as in test-fixtures, but the finish sits
// in the middle of the bottom straight (x=20, spanning from the outer wall y=0 to
// the inner wall y=8): there the line blocks the road wall-to-wall, just like
// clipFinishLine builds it in the game. The fixture's default finish (x=6) sits in
// the left corridor, where there's no inner wall — its end could legally be driven
// around, breaking lap semantics.
// Race direction is +x: sideOfFinish(p) = p.x − 20, starts are to the left of the line.

import { describe, it, expect } from 'vitest';
import { chooseMove, Difficulty } from './index';
import { buildNavField, navAt } from '../nav';
import { candidates, applyMove, coastMove } from '../turns';
import {
  GameState,
  Player,
  Rules,
  DEFAULT_RULES,
  computeOutcome,
  WIN_CROSSINGS,
} from '../game';
import { Track, key, unkey, finalizeTrack } from '../track';
import { DRIVE_PRESETS } from '../../config';
import { Vec, dist } from '../../geometry';
import { OUTER, INNER, gameOn } from '../test-fixtures';

const FIN_X = 20;

function aiTrack(): Track {
  // Line endpoints are extended 0.25 past the walls, just like clipFinishLine does:
  // otherwise a gap remains in the tolerance band next to the wall that lets a car
  // "duck under" the end of the line without crossing it — and the AI happily
  // finds that loophole.
  const res = finalizeTrack(
    OUTER,
    INNER,
    { a: { x: FIN_X, y: -0.25 }, b: { x: FIN_X, y: 8.25 } },
    { x: 1, y: 0 },
  );
  if ('error' in res) throw new Error(`aiTrack fixture invalid: ${res.error}`);
  return res.track;
}

const track = aiTrack();
const nav = buildNavField(track);

/** Player at a given point with a given velocity (for synthetic states). */
function playerAt(pos: Vec, vel: Vec = { x: 0, y: 0 }): Player {
  return {
    name: 'p',
    color: '#000',
    pos: { ...pos },
    vel: { ...vel },
    trail: [],
    crashes: [],
    skipTurns: 0,
    crossings: 0,
    finishOvershoot: null,
    place: null,
    retired: false,
  };
}

/** Deterministic rng stub: always returns the same value. */
const rngConst = (v: number) => (): number => v;

describe('buildNavField', () => {
  it('covers every track node with a finite distance', () => {
    track.inside.forEach((k) => {
      expect(
        nav.dist.get(k),
        `no distance for ${JSON.stringify(unkey(k))}`,
      ).toBeGreaterThan(0);
    });
  });

  it('seeds (dist=1) lie strictly past the finish line', () => {
    let min = Infinity;
    nav.dist.forEach((d, k) => {
      min = Math.min(min, d);
      if (d === 1) expect(unkey(k).x).toBeLessThan(FIN_X);
    });
    expect(min).toBe(1);
  });

  it('a cell right after the finish routes the long way around (≈ a full lap), not backward', () => {
    const ahead = nav.dist.get(key(FIN_X + 1, 3))!;
    expect(ahead).toBeGreaterThan(nav.lap * 0.8);
  });

  it('distance decreases monotonically along the race direction', () => {
    // Bottom straight ahead of the line: race direction is +x, further around the lap is closer to the finish.
    expect(nav.dist.get(key(25, 3))!).toBeGreaterThan(nav.dist.get(key(35, 3))!);
    // Top straight: race direction is −x.
    expect(nav.dist.get(key(30, 20))!).toBeGreaterThan(nav.dist.get(key(10, 20))!);
    // Past the line: the closer to the finish, the smaller.
    expect(nav.dist.get(key(12, 3))!).toBeGreaterThan(nav.dist.get(key(18, 3))!);
  });
});

describe('navAt', () => {
  it('works for fractional points off the track nodes (tolerance band)', () => {
    const v = navAt(nav, { x: 30.4, y: 0.1 });
    expect(v).toBeLessThan(nav.lap);
    // Close to the neighboring node's value (up to the euclidean top-up).
    expect(Math.abs(v - nav.dist.get(key(30, 1))!)).toBeLessThan(2.5);
  });

  it('deep gravel (outside the search window) gives a conservative lap-length estimate', () => {
    expect(navAt(nav, { x: 200, y: 200 })).toBe(nav.lap);
  });

  // Regression: the field must not "leak" into an adjacent pass of the track through
  // a thin partition. Ring with a 2-thick inner wall (y∈[11,13]): the bottom corridor
  // (near the finish, far around the lap) and the top corridor ("back straight", close
  // to the finish) run about 3 cells apart. A point in the bottom corridor above the
  // partition is euclidean-close to a cheap node in the top corridor; without a
  // line-of-sight check, navAt would grab that minimum and the bot would drive into
  // the wall.
  it('does not leak through a thin partition between passes', () => {
    const res = finalizeTrack(
      OUTER,
      [
        { x: 4, y: 11 },
        { x: 36, y: 11 },
        { x: 36, y: 13 },
        { x: 4, y: 13 },
      ],
      { a: { x: 6, y: -0.25 }, b: { x: 6, y: 11.25 } },
      { x: 1, y: 0 },
    );
    if ('error' in res) throw new Error(`fixture invalid: ${res.error}`);
    const thinNav = buildNavField(res.track);

    // The top corridor node behind the partition is genuinely cheap (close to the finish).
    const backStraight = navAt(thinNav, { x: 20, y: 14 });
    expect(backStraight).toBeLessThan(30);

    // Point in the bottom corridor by the partition: it has almost a full lap left to the finish.
    // With line-of-sight, this is a genuinely large value (~58); if it leaked through the
    // wall it would collapse to the cheap top-corridor node (~24).
    const nearWall = navAt(thinNav, { x: 20, y: 10.5 });
    expect(nearWall).toBeGreaterThan(50);
    expect(nearWall).toBeGreaterThan(backStraight + 25);
  });
});

/** Runs a race where a bot of the given difficulty controls every seat. */
function botRace(players: number, difficulty: Difficulty, maxTurns: number): GameState {
  const state = gameOn(track, players);
  const rng = rngConst(0.99); // no epsilon-randomness — a deterministic run
  for (let i = 0; i < maxTurns && state.phase === 'race'; i++) {
    const cand = chooseMove(state, nav, difficulty, rng);
    if (cand) applyMove(state, cand);
    else coastMove(state);
  }
  return state;
}

describe('chooseMove', () => {
  it('a lone hard bot completes a lap without ever crashing', () => {
    // Pure wall-safety invariant: the opponent sits at the start and passes
    // (coastMove at zero speed), so there's no traffic. The opponent never finishes
    // or retires, so the race formally never ends — we check that the bot itself
    // reached the finish (became the winner and got place 1) with no crashes.
    const state = gameOn(track, 2);
    const rng = rngConst(0.99);
    for (let i = 0; i < 400 && state.winner === null; i++) {
      if (state.current === 0) {
        const cand = chooseMove(state, nav, 'hard', rng);
        if (cand) applyMove(state, cand);
        else coastMove(state);
      } else {
        coastMove(state);
      }
    }
    expect(state.winner).toBe(0);
    expect(state.players[0].place).toBe(1);
    expect(state.players[0].crashes).toHaveLength(0);
  });

  // Hard's strength: A* minimizes the NUMBER OF MOVES (not path length), so it
  // carries speed through linkages and clears a twisty track noticeably faster than
  // the old greedy bot. The hairpin (two 180° turns around a thin tongue) is where a
  // greedy inside line is especially slow. The threshold has margin over the measured
  // value (~29); it trips if the planner degrades back to "path optimization."
  it('a hard bot clears a twisty track in few moves (time-optimal)', () => {
    const hp = finalizeTrack(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 20 },
        { x: 0, y: 20 },
      ],
      [
        { x: 4, y: 8 },
        { x: 36, y: 8 },
        { x: 36, y: 12 },
        { x: 4, y: 12 },
      ],
      { a: { x: 20, y: -0.25 }, b: { x: 20, y: 8.25 } },
      { x: 1, y: 0 },
    );
    if ('error' in hp) throw new Error(`fixture invalid: ${hp.error}`);
    const hpNav = buildNavField(hp.track);
    const state = gameOn(hp.track, 2);
    state.players[1].retired = true; // solo: no opponent in the way
    const rng = rngConst(0.99);
    let moves = 0;
    for (let i = 0; i < 400 && state.winner === null; i++) {
      const cand = chooseMove(state, hpNav, 'hard', rng);
      if (cand) applyMove(state, cand);
      else coastMove(state);
      moves += 1;
    }
    expect(state.winner).toBe(0);
    expect(state.players[0].crashes).toHaveLength(0);
    expect(moves).toBeLessThanOrEqual(34);
  });

  it('hard bots play out a race with almost no crashes', () => {
    // In dense traffic a forced crash is possible (opponents beyond the first layer
    // aren't forecast) — but it should remain rare.
    const state = botRace(4, 'hard', 400);
    expect(state.phase).toBe('over');
    expect(state.winner).not.toBeNull();
    const totalCrashes = state.players.reduce((s, p) => s + p.crashes.length, 0);
    expect(totalCrashes).toBeLessThanOrEqual(2);
  });

  it('easy bots play out a race without deadlocking (crashes are allowed)', () => {
    const state = botRace(4, 'easy', 800);
    expect(state.phase).toBe('over');
    expect(state.winner).not.toBeNull();
  });

  it('an easy bot respects the soft speed cap', () => {
    // Long bottom straight, speed is already at the cap (4): accelerating further
    // would gain distance, but the overspeed penalty should outweigh it.
    const state = gameOn(track, 2);
    const me = state.players[0];
    me.pos = { x: 22, y: 4 };
    me.vel = { x: 4, y: 0 };
    state.players[1].pos = { x: 12, y: 22 }; // opponent is out of the way
    const cand = chooseMove(state, nav, 'easy', rngConst(0.99))!;
    expect(dist(me.pos, cand.target)).toBeLessThanOrEqual(4);
  });

  it('never returns a blocked candidate', () => {
    const state = gameOn(track, 2);
    const me = state.players[0];
    me.pos = { x: 24, y: 3 };
    me.vel = { x: 1, y: 0 };
    state.players[1].pos = { x: 25, y: 3 }; // opponent directly ahead
    for (let i = 0; i < 20; i++) {
      const cand = chooseMove(state, nav, 'easy', rngConst(i / 20));
      expect(cand).not.toBeNull();
      expect(cand!.blocked).toBe(false);
    }
  });

  it('returns null when fully surrounded (all 9 candidates blocked)', () => {
    const state = gameOn(track, 2);
    const me = state.players[0];
    me.pos = { x: 24, y: 3 };
    me.vel = { x: 2, y: 0 };
    // All 9 targets (x∈25..27, y∈2..4) are occupied by opponents — a synthetic deadlock.
    state.players.length = 1;
    for (let y = 2; y <= 4; y++) {
      for (let x = 25; x <= 27; x++) state.players.push(playerAt({ x, y }));
    }
    expect(candidates(state).every((c) => c.blocked)).toBe(true);
    expect(chooseMove(state, nav, 'hard')).toBeNull();
  });

  it('maximizes overshoot past the line on the finishing move', () => {
    const state = gameOn(track, 2);
    const me = state.players[0];
    me.crossings = 1; // lap complete, only the finish crossing remains
    me.pos = { x: 17, y: 3 };
    me.vel = { x: 3, y: 0 }; // targets x∈19..21: crossing at x=20, deeper at x=21
    state.players[1].pos = { x: 3, y: 22 };
    const cand = chooseMove(state, nav, 'hard')!;
    expect(cand.target.x).toBe(21); // deepest overshoot past the line
  });

  it('picks the smallest penalty when a crash is unavoidable', () => {
    const state = gameOn(track, 2);
    // Classic mode: exactly 3 targets ahead, all past the wall — unavoidable (in the
    // realistic model, braking could escape it, and the trap would stop being a trap).
    state.rules.drive = { ...DRIVE_PRESETS.classic };
    const me = state.players[0];
    me.pos = { x: 36, y: 3 };
    me.vel = { x: 6, y: 0 }; // targets x∈41..43 — all past the outer wall (x=40)
    state.players[1].pos = { x: 3, y: 22 };
    const cands = candidates(state);
    expect(cands.every((c) => c.crash)).toBe(true);
    const cand = chooseMove(state, nav, 'hard')!;
    const chosen = computeOutcome(track, state.rules, me.pos, cand.target);
    const minSkip = Math.min(
      ...cands.map((c) => computeOutcome(track, state.rules, me.pos, c.target).skipTurns),
    );
    expect(chosen.skipTurns).toBe(minSkip);
  });

  it('hard bot is deterministic', () => {
    const state = gameOn(track, 3);
    const a = chooseMove(state, nav, 'hard')!;
    const b = chooseMove(state, nav, 'hard')!;
    expect(a.target).toEqual(b.target);
  });

  // Opponents shouldn't sabotage the bot's pace. The old "repulsion" (a penalty for
  // being close to an opponent) forced the bot to yield the racing line to any rival
  // and cost it ~40% of its pace (~68 moves in a pack vs ~46 solo), which let a human
  // pull away easily even 1-on-1. Now there's no repulsion: cars route around each
  // other through the search itself (blocked moves are filtered out, the plan routes
  // around them), and in a pack they run at almost solo pace. We check: the pack
  // leader lands close to solo, everyone finishes without deadlocking, and no one
  // drives against the direction of the track.
  it("opponents do not sabotage the bot's pace (in a pack ≈ solo)", () => {
    const wide = finalizeTrack(
      [
        { x: 0, y: 0 },
        { x: 60, y: 0 },
        { x: 60, y: 40 },
        { x: 0, y: 40 },
      ],
      [
        { x: 10, y: 10 },
        { x: 50, y: 10 },
        { x: 50, y: 30 },
        { x: 10, y: 30 },
      ],
      { a: { x: 30, y: -0.25 }, b: { x: 30, y: 10.25 } },
      { x: 1, y: 0 },
    );
    if ('error' in wide) throw new Error(`fixture invalid: ${wide.error}`);
    const wnav = buildNavField(wide.track);
    const rng = rngConst(0.37);

    // Solo: a single bot (opponent removed) — the pace baseline.
    const s0 = gameOn(wide.track, 2);
    s0.players[1].retired = true;
    let soloMoves = 0;
    for (let i = 0; i < 600 && s0.winner === null; i++) {
      const c = chooseMove(s0, wnav, 'hard', rng);
      if (c) applyMove(s0, c);
      else coastMove(s0);
      soloMoves += 1;
    }
    expect(s0.winner).toBe(0);

    // Pack of 4: each one's own move count until finishing + a check for backward moves.
    const state = gameOn(wide.track, 4);
    const my = state.players.map(() => 0);
    const lap: (number | null)[] = state.players.map(() => null);
    let backward = 0;
    for (let i = 0; i < 1600 && state.phase === 'race'; i++) {
      const seat = state.current;
      const p = state.players[seat];
      if (p.place !== null || p.retired || p.skipTurns > 0) {
        coastMove(state);
        continue;
      }
      my[seat] += 1;
      const navBefore = navAt(wnav, p.pos);
      const crossBefore = p.crossings;
      const cand = chooseMove(state, wnav, 'hard', rng);
      if (cand) applyMove(state, cand);
      else coastMove(state);
      const sp = state.players[seat];
      if (lap[seat] === null && sp.crossings >= WIN_CROSSINGS) lap[seat] = my[seat];
      if (sp.crossings === crossBefore && sp.skipTurns === 0) {
        if (navAt(wnav, sp.pos) > navBefore + 3) backward += 1;
      }
    }
    expect(state.players.filter((q) => q.place !== null).length).toBe(4); // no deadlock
    expect(backward).toBe(0); // no one drives against the track direction
    const winnerMoves = Math.min(...lap.filter((x): x is number => x !== null));
    // The pack leader is close to solo (not doubled, as with the old repulsion).
    expect(winnerMoves).toBeLessThanOrEqual(soloMoves + 6);
  });
});

// ── Unified A*: all difficulty levels share one engine, differing only in how much it's "weakened" ──

/** A varying deterministic PRNG (unlike rngConst, which always returns one value).
 *  Needed to measure the real rate of easy's "live" crashes: with a constant rng
 *  the same mistake would repeat every lap and lock the bot into looping at one corner. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A spacious track: long straights push into the soft speed cap, so difficulty
 *  levels diverge in move count (on tight tracks they converge). */
function bigTrack(): Track {
  const res = finalizeTrack(
    [
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 120, y: 70 },
      { x: 0, y: 70 },
    ],
    [
      { x: 20, y: 20 },
      { x: 100, y: 20 },
      { x: 100, y: 50 },
      { x: 20, y: 50 },
    ],
    { a: { x: 60, y: -0.25 }, b: { x: 60, y: 20.25 } },
    { x: 1, y: 0 },
  );
  if ('error' in res) throw new Error(`bigTrack fixture invalid: ${res.error}`);
  return res.track;
}

/** A twisty hairpin track (thin tongue, two 180° turns): narrow linkages
 *  where easy driving at the edge most often fails to brake in time. */
function hairpinTrack(): Track {
  const res = finalizeTrack(
    [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 20 },
      { x: 0, y: 20 },
    ],
    [
      { x: 4, y: 8 },
      { x: 36, y: 8 },
      { x: 36, y: 12 },
      { x: 4, y: 12 },
    ],
    { a: { x: 20, y: -0.25 }, b: { x: 20, y: 8.25 } },
    { x: 1, y: 0 },
  );
  if ('error' in res) throw new Error(`hairpinTrack fixture invalid: ${res.error}`);
  return res.track;
}

/** A solo bot run (opponent removed): moves to finish, crash count, whether it finished. */
function soloFinish(
  t: Track,
  n: ReturnType<typeof buildNavField>,
  difficulty: Difficulty,
  rng: () => number,
  rules?: Rules,
): { moves: number; crashes: number; won: boolean } {
  const state = gameOn(t, 2, rules);
  state.players[1].retired = true;
  let moves = 0;
  for (let i = 0; i < 1200 && state.winner === null; i++) {
    const cand = chooseMove(state, n, difficulty, rng);
    if (cand) applyMove(state, cand);
    else coastMove(state);
    moves += 1;
  }
  return { moves, crashes: state.players[0].crashes.length, won: state.winner === 0 };
}

describe('difficulty levels (unified A*)', () => {
  // The gap between difficulty levels is handled by having all of them share one A*,
  // weakened by horizon/greediness/speed cap. On a spacious track this produces a clear
  // monotonic staircase in move count (measured ~50/59/71 for hard/medium/easy).
  it('the staircase is monotonic: hard < medium < easy in move count', () => {
    const t = bigTrack();
    const n = buildNavField(t);
    const h = soloFinish(t, n, 'hard', rngConst(0.99));
    const m = soloFinish(t, n, 'medium', rngConst(0.99));
    const e = soloFinish(t, n, 'easy', rngConst(0.99));
    expect(h.won && m.won && e.won).toBe(true);
    expect(h.crashes).toBe(0);
    expect(h.moves).toBeLessThan(m.moves);
    expect(m.moves).toBeLessThan(e.moves);
    // Margin over noise: each level is clearly separated (measurements show gaps of 9 and 12).
    expect(m.moves - h.moves).toBeGreaterThanOrEqual(4);
    expect(e.moves - m.moves).toBeGreaterThanOrEqual(4);
  });

  // easy drives on the edge (enforceStop=false) and occasionally fails to brake in
  // time — the "liveliness" of the weak level. What matters: the crash is rare and does
  // NOT loop (after returning from the gravel, speed is reset and the bot drives on).
  // medium/hard hold the safety invariant and never crash at all.
  it('easy crashes occasionally (without looping), medium and hard never do', () => {
    const t = hairpinTrack();
    const n = buildNavField(t);
    const N = 20;

    let easyCrashRaces = 0;
    let easyMaxPerRace = 0;
    let easyAllFinished = true;
    for (let k = 0; k < N; k++) {
      const r = soloFinish(t, n, 'easy', mulberry32(1000 + k * 7));
      if (r.crashes > 0) easyCrashRaces += 1;
      easyMaxPerRace = Math.max(easyMaxPerRace, r.crashes);
      if (!r.won) easyAllFinished = false;
    }
    expect(easyCrashRaces).toBeGreaterThanOrEqual(1); // the crash lever is alive
    expect(easyCrashRaces).toBeLessThan(N); // but not in every race — genuinely "occasionally"
    expect(easyMaxPerRace).toBeLessThanOrEqual(3); // doesn't loop at one corner
    expect(easyAllFinished).toBe(true); // no deadlock

    // medium/hard: safety invariant — zero crashes on the same seeds.
    // Fewer runs: they're more expensive (deeper search) and deterministically safe.
    for (const level of ['medium', 'hard'] as const) {
      let crashes = 0;
      for (let k = 0; k < 8; k++) {
        crashes += soloFinish(t, n, level, mulberry32(1000 + k * 7)).crashes;
      }
      expect(crashes, `${level} must never crash`).toBe(0);
    }
  }, 15000);

  // The bot expands search nodes using the same target generator as the engine
  // (turns.ts), so it plays under the realistic physics model (traction circle), not
  // just classic mode.
  it('the bot clears a lap under realistic physics with no crashes', () => {
    // gt ≈ the old realistic preset (grip 2, brake 2) + light downforce — this also
    // checks that the bot handles downforce (it inherits reachableTargets).
    const rules: Rules = { ...DEFAULT_RULES, drive: { ...DRIVE_PRESETS.gt } };
    const t = bigTrack();
    const n = buildNavField(t);
    const r = soloFinish(t, n, 'hard', rngConst(0.99), rules);
    expect(r.won).toBe(true);
    expect(r.crashes).toBe(0);
    expect(r.moves).toBeLessThanOrEqual(70); // measured ~42; threshold with margin
  });
});
