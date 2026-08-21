import { describe, it, expect } from 'vitest';
import {
  Rules,
  DEFAULT_RULES,
  crashPenalty,
  newGame,
  shuffledIndices,
  cloneState,
  returnFromPenalty,
  nearestFreeInsidePoint,
  isFinished,
  humansAllDone,
  hasLiveBots,
  lapStartIndex,
  computeOutcome,
  offRoadDepth,
  applyOutcome,
  resolveRound,
  GameState,
} from './game';
import { Vec } from '../geometry';
import { CRASH_PENALTY_MAX, OFFROAD_FORGIVE } from '../config';
import { ringTrack } from './test-fixtures';

describe('shuffledIndices', () => {
  // Deterministic PRNG for repeatability (same as mulberry32 in ai.test.ts).
  const mulberry32 = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('returns a permutation of [0..n)', () => {
    const p = shuffledIndices(6, mulberry32(1));
    expect([...p].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('is deterministic given the same rng', () => {
    expect(shuffledIndices(6, mulberry32(42))).toEqual(
      shuffledIndices(6, mulberry32(42)),
    );
  });
});

describe('newGame startOrder', () => {
  it('assigns starting cells according to the given permutation', () => {
    const t = ringTrack();
    const order = [2, 0, 1];
    const g = newGame(t, 3, DEFAULT_RULES, order);
    for (let i = 0; i < 3; i++) {
      expect(g.players[i].pos).toEqual(t.startPoints[order[i]]);
    }
  });

  it('defaults to the identity assignment (pole goes to seat 0)', () => {
    const t = ringTrack();
    const g = newGame(t, 3);
    for (let i = 0; i < 3; i++) {
      expect(g.players[i].pos).toEqual(t.startPoints[i]);
    }
  });
});

describe('crashPenalty', () => {
  const dyn = (exp: number): Rules => ({
    ...DEFAULT_RULES,
    penalty: 'dynamic',
    dynamicExponent: exp,
  });

  it('static penalty is a fixed number of moves, independent of speed', () => {
    const rules: Rules = { ...DEFAULT_RULES, penalty: 'static', staticTurns: 4 };
    expect(crashPenalty(rules, 1)).toBe(4);
    expect(crashPenalty(rules, 7)).toBe(4);
  });

  it('dynamic (severity 1) is round(speed), clamped to [1, MAX]', () => {
    expect(crashPenalty(dyn(1), 0.5)).toBe(1);
    expect(crashPenalty(dyn(1), 2)).toBe(2);
    expect(crashPenalty(dyn(1), 3)).toBe(3);
    expect(crashPenalty(dyn(1), 100)).toBe(CRASH_PENALTY_MAX);
  });

  it('dynamic (severity 1.5) is steeper for high-speed crashes', () => {
    expect(crashPenalty(dyn(1.5), 1)).toBe(1);
    expect(crashPenalty(dyn(1.5), 2)).toBe(3);
    expect(crashPenalty(dyn(1.5), 3)).toBe(5);
    expect(crashPenalty(dyn(1.5), 4)).toBe(CRASH_PENALTY_MAX); // 4^1.5 = 8
  });
});

describe('computeOutcome — the crash tolerance band and where impact lands', () => {
  // The fixture's road is the band between the outer rect (0,0)-(40,24) and the
  // inner one (8,8)-(32,16), so the inner corner (8,8) is an apex to cut and the
  // outer wall y=0 is a straight edge to drift past. A crash is "depth past the
  // edge > OFFROAD_FORGIVE" anywhere along the move — neither "the move ends off
  // the road" nor "the move crosses a wall". The first two cases are the ones
  // those cheaper criteria get wrong; the rest are the grazes forgiveness owes.
  const track = ringTrack();
  const outcome = (from: Vec, to: Vec) => computeOutcome(track, DEFAULT_RULES, from, to);

  // Across the inner corner: both ends on the road, the middle deep in the grass.
  const APEX_CUT: [Vec, Vec] = [
    { x: 6, y: 10 },
    { x: 12, y: 6 },
  ];
  // Starting where a previous crash left the car — inside the band past y=0 —
  // and sinking deeper on the same side, so no wall is ever crossed.
  const SINK_IN_BAND: [Vec, Vec] = [
    { x: 10, y: -0.03 },
    { x: 10, y: -1 },
  ];

  it('cutting the apex crashes even though both ends of the move are on the road', () => {
    const [from, to] = APEX_CUT;
    expect(offRoadDepth(track, from)).toBe(0);
    expect(offRoadDepth(track, to)).toBe(0); // an endpoint check alone would see nothing

    const o = outcome(from, to);
    expect(o.crash).toBe(true);
    expect(o.end).not.toEqual(to);
    // Impact on the way in, at the inner wall x=8 — one tolerance past it.
    expect(o.end.x).toBeCloseTo(8 + OFFROAD_FORGIVE, 6);
  });

  it('going deeper from inside the tolerance band crashes, though the move never crosses a wall', () => {
    const [from, to] = SINK_IN_BAND;
    expect(offRoadDepth(track, from)).toBeGreaterThan(0);
    expect(offRoadDepth(track, to)).toBeGreaterThan(0); // both ends past the wall: no crossing to find

    const o = outcome(from, to);
    expect(o.crash).toBe(true);
    expect(o.end.y).toBeCloseTo(-OFFROAD_FORGIVE, 6);
  });

  it('puts the crash point on the tolerance isoline, whichever wall it was', () => {
    const straightThroughTheWall: [Vec, Vec] = [
      { x: 10, y: 1 },
      { x: 10, y: -3 },
    ];
    for (const [from, to] of [APEX_CUT, SINK_IN_BAND, straightThroughTheWall]) {
      const o = outcome(from, to);
      expect(o.crashAt).not.toBeNull();
      expect(offRoadDepth(track, o.crashAt!)).toBeCloseTo(OFFROAD_FORGIVE, 6);
    }
  });

  it('forgives a graze that stays shallower than the tolerance', () => {
    const to = { x: 10, y: -OFFROAD_FORGIVE + 0.01 };
    const o = outcome({ x: 10, y: 1 }, to);
    expect(o.crash).toBe(false);
    expect(o.end).toEqual(to);
  });

  it('forgives a move that starts inside the band and comes back onto the road', () => {
    const to = { x: 10, y: 2 };
    const o = outcome(SINK_IN_BAND[0], to);
    expect(o.crash).toBe(false);
    expect(o.end).toEqual(to);
  });

  it('forgives a move that runs along the band without getting deeper than the tolerance', () => {
    const o = outcome(SINK_IN_BAND[0], { x: 14, y: -0.04 });
    expect(o.crash).toBe(false);
  });
});

describe('nearestFreeInsidePoint — the tie-break between equidistant cells', () => {
  // Which cell the gravel spits a car back onto has to be a function of the game
  // state alone: the replay re-runs the race from the same moves, and online both
  // sides compute the return independently. A tie broken by whatever order
  // track.inside happens to iterate in would desync both. The rule is lowest y,
  // then lowest x — the cases below are the ones that tell it apart from "first
  // cell found" and from an x-first ordering.
  const gameWithCarsAt = (...at: Vec[]): GameState => {
    const g = newGame(ringTrack(), at.length + 1);
    at.forEach((pos, i) => (g.players[i + 1].pos = { ...pos }));
    return g;
  };

  it('answers the same whichever order track.inside is walked in', () => {
    // The rule only earns its keep if it survives a reordering: walk the same
    // cells back to front and the tie must still resolve to (10,1). The query
    // point sits in the gravel past the wall y=0, halfway between (10,1) and
    // (11,1).
    const g = gameWithCarsAt();
    const reversed = gameWithCarsAt();
    reversed.track = {
      ...reversed.track,
      inside: new Set([...reversed.track.inside].reverse()),
    };

    const q = { x: 10.5, y: -0.05 };
    expect(nearestFreeInsidePoint(g, q, 0)).toEqual({ x: 10, y: 1 });
    expect(nearestFreeInsidePoint(reversed, q, 0)).toEqual({ x: 10, y: 1 });
  });

  it('lets y outrank x: the lower row wins even when its cell is further along x', () => {
    // (10.5, 1.5) sits at the centre of the square (10,1)-(11,2) — all four
    // corners tie. With (10,1) and (11,2) taken, the choice is between (11,1)
    // and (10,2): an x-first rule would answer (10,2).
    const g = gameWithCarsAt({ x: 10, y: 1 }, { x: 11, y: 2 });
    expect(nearestFreeInsidePoint(g, { x: 10.5, y: 1.5 }, 0)).toEqual({ x: 11, y: 1 });
  });

  it('skips cells held by other cars and breaks the tie among what is left', () => {
    const g = gameWithCarsAt({ x: 10, y: 1 });
    expect(nearestFreeInsidePoint(g, { x: 10.5, y: -0.05 }, 0)).toEqual({ x: 11, y: 1 });
  });
});

describe('returnFromPenalty — crossing the finish via the return teleport', () => {
  // The fixture's finish is the line x=6, race direction +x; sideOfFinish(p) = p.x − 6.
  // Opponents at (4,1)/(5,1)/(6,1) occupy cells behind and on the line, so the nearest
  // free cell to the crash point (5.5, 0.4) is node (7,1), already PAST the line: the
  // return jumps across the finish.
  function crashedBehindFinish(crossings: number) {
    const g = newGame(ringTrack(), 4);
    g.players[1].pos = { x: 4, y: 1 };
    g.players[2].pos = { x: 5, y: 1 };
    g.players[3].pos = { x: 6, y: 1 };
    g.players[0].pos = { x: 5.5, y: 0.4 }; // in the gravel behind the line (x<6)
    g.players[0].crossings = crossings;
    return g;
  }

  it('a return past the line counts a lap (+1 to crossings)', () => {
    const g = crashedBehindFinish(0);
    returnFromPenalty(g, 0);
    expect(g.players[0].pos).toEqual({ x: 7, y: 1 }); // past the line
    expect(g.players[0].crossings).toBe(1);
  });

  it('a return to the same side of the line leaves the counter untouched', () => {
    const g = newGame(ringTrack(), 2);
    g.players[1].pos = { x: 20, y: 10 }; // out of the way
    g.players[0].pos = { x: 5.4, y: 0.3 }; // nearest free cell is (5,1), also behind
    g.players[0].crossings = 0;
    returnFromPenalty(g, 0);
    expect(g.players[0].pos.x).toBeLessThan(6); // stayed behind the line
    expect(g.players[0].crossings).toBe(0);
  });

  it('a return across the line with laps still to go does not finish the car', () => {
    const g = crashedBehindFinish(1);
    g.rules.winCrossings = 4; // three-lap race: crossing #2 is only a lap
    returnFromPenalty(g, 0);
    expect(g.players[0].crossings).toBe(2);
    expect(g.players[0].finishOvershoot).toBeNull();
  });

  it('a return that completes the winning lap sets finishOvershoot', () => {
    const g = crashedBehindFinish(DEFAULT_RULES.winCrossings - 1);
    returnFromPenalty(g, 0);
    expect(g.players[0].crossings).toBe(g.rules.winCrossings);
    expect(g.players[0].finishOvershoot).toBe(1); // sideOfFinish(7,1) = 1
  });
});

describe('isFinished — the window between crossing the finish and getting a place', () => {
  it('an active car is not considered finished', () => {
    const g = newGame(ringTrack(), 2);
    expect(isFinished(g.players[0])).toBe(false);
  });

  it('a car that crossed the finish (finishOvershoot set, place still null) has already finished', () => {
    // Exactly the round's play-out window: resolveRound hasn't set place yet.
    const g = newGame(ringTrack(), 2);
    g.players[0].crossings = g.rules.winCrossings;
    g.players[0].finishOvershoot = 1;
    expect(g.players[0].place).toBeNull();
    expect(isFinished(g.players[0])).toBe(true);
  });

  it('a car with a place assigned has finished', () => {
    const g = newGame(ringTrack(), 2);
    g.players[0].place = 1;
    expect(isFinished(g.players[0])).toBe(true);
  });
});

describe('humansAllDone / hasLiveBots — early-exit gate for retired humans', () => {
  it('solo human vs a bot: not done while the human is still racing', () => {
    const g = newGame(ringTrack(), 2);
    g.players[1].bot = 'medium';
    expect(humansAllDone(g)).toBe(false);
    expect(hasLiveBots(g)).toBe(true);
  });

  it('solo human vs a bot: done once the human retires, bot still live', () => {
    const g = newGame(ringTrack(), 2);
    g.players[1].bot = 'medium';
    g.players[0].retired = true;
    expect(humansAllDone(g)).toBe(true);
    expect(hasLiveBots(g)).toBe(true);
  });

  it('hotseat, two humans: not done while one is still active', () => {
    const g = newGame(ringTrack(), 3);
    g.players[2].bot = 'medium';
    g.players[0].retired = true;
    expect(humansAllDone(g)).toBe(false);
  });

  it('hotseat, two humans: done once both retire or finish, bot still live', () => {
    const g = newGame(ringTrack(), 3);
    g.players[2].bot = 'medium';
    g.players[0].retired = true;
    g.players[1].place = 1;
    expect(humansAllDone(g)).toBe(true);
    expect(hasLiveBots(g)).toBe(true);
  });

  it('no bots left: hasLiveBots is false once the bot retires or finishes', () => {
    const g = newGame(ringTrack(), 2);
    g.players[1].bot = 'medium';
    g.players[1].retired = true;
    expect(hasLiveBots(g)).toBe(false);
  });

  it('all-human race is trivially done once everyone has a place or retired', () => {
    const g = newGame(ringTrack(), 2);
    g.players[0].place = 1;
    g.players[1].retired = true;
    expect(humansAllDone(g)).toBe(true);
    expect(hasLiveBots(g)).toBe(false);
  });
});

describe('cloneState', () => {
  it('is deeply independent per player, but track is shared by reference', () => {
    const g = newGame(ringTrack(), 2);
    const c = cloneState(g);
    c.players[0].pos.x = 999;
    expect(g.players[0].pos.x).not.toBe(999);
    expect(c.track).toBe(g.track);
  });
});

describe('lapStartIndex', () => {
  // The fixture's finish line is x=6 crossed in +x, so a segment from x<6 to
  // x>=6 is a lap; the way back over it is a lap given up.
  const seg = (x0: number, x1: number, jump = false) => ({
    from: { x: x0, y: 4 },
    to: { x: x1, y: 4 },
    jump,
    turn: 0,
  });

  it('is 0 while the car has not reached the line yet', () => {
    const trail = [seg(1, 3), seg(3, 5)];
    expect(lapStartIndex(ringTrack(), trail)).toBe(0);
  });

  it('starts the lap at the crossing segment itself', () => {
    const trail = [seg(1, 3), seg(3, 5), seg(5, 8), seg(8, 12)];
    expect(lapStartIndex(ringTrack(), trail)).toBe(2);
  });

  it('moves on with every further crossing', () => {
    const track = ringTrack();
    const trail = [seg(4, 7), seg(2, 5), seg(5, 9), seg(9, 12)];
    expect(lapStartIndex(track, trail)).toBe(2);
  });

  it('drops back into the previous lap when the line is crossed backwards', () => {
    const track = ringTrack();
    const trail = [seg(4, 7), seg(7, 9), seg(9, 5), seg(5, 3)];
    expect(lapStartIndex(track, trail)).toBe(0);
  });

  it('counts the teleport out of the gravel as a crossing, like the rules do', () => {
    const trail = [seg(1, 3), seg(3, 5), seg(5, 9, true)];
    expect(lapStartIndex(ringTrack(), trail)).toBe(2);
  });

  it('keeps the finishing lap on show: the winning crossing opens no lap', () => {
    const track = ringTrack();
    // Two crossings, the second of them the winning one: the lap on show is
    // still the one that was driven to get there.
    const trail = [seg(1, 3), seg(3, 7), seg(7, 9), seg(2, 5), seg(5, 9)];
    expect(lapStartIndex(track, trail, trail.length, 2)).toBe(1);
    // Same trail with the flag further off is an ordinary lap change.
    expect(lapStartIndex(track, trail, trail.length, 3)).toBe(4);
  });

  it('a lap given up after the flag does not eat the lap before it', () => {
    const track = ringTrack();
    const trail = [seg(4, 7), seg(7, 9), seg(9, 4)];
    expect(lapStartIndex(track, trail, trail.length, 1)).toBe(0);
  });

  it('only looks at the first `count` segments, for a car mid-replay', () => {
    const track = ringTrack();
    const trail = [seg(1, 3), seg(3, 5), seg(5, 8), seg(8, 12)];
    expect(lapStartIndex(track, trail, 2)).toBe(0);
    expect(lapStartIndex(track, trail, 3)).toBe(2);
  });
});

describe('resolveRound — places inside the finishing round', () => {
  /**
   * Drive `seat` from `from` to `to` as its finishing move (one crossing short
   * of the win beforehand) and enter it in the round. The fixture's finish is
   * the vertical line x=6, so a move along a row crosses it at a predictable
   * fraction.
   */
  function finishWith(g: GameState, seat: number, from: Vec, to: Vec): void {
    const p = g.players[seat];
    p.pos = { ...from };
    p.crossings = g.rules.winCrossings - 1;
    applyOutcome(
      g.track,
      p,
      computeOutcome(g.track, g.rules, from, to),
      g.turn,
      g.rules.winCrossings,
    );
    g.roundFinishers.push(seat);
  }

  it('ranks by when the line was cut, not by how far past it the car ended', () => {
    const g = newGame(ringTrack(), 2);
    // Slow car: cuts the line halfway through a short move, stops just past it.
    finishWith(g, 0, { x: 5, y: 3 }, { x: 7, y: 3 });
    // Fast car: covers more ground in the same turn and ends deeper, but only
    // reaches the line four sevenths of the way through its move.
    finishWith(g, 1, { x: 2, y: 5 }, { x: 9, y: 5 });
    expect(g.players[1].finishOvershoot).toBeGreaterThan(g.players[0].finishOvershoot!);

    resolveRound(g);
    expect(g.players[0].place).toBe(1);
    expect(g.players[1].place).toBe(2);
  });

  it('falls back to overshoot depth when the line was cut at the same moment', () => {
    const g = newGame(ringTrack(), 2);
    finishWith(g, 0, { x: 5, y: 3 }, { x: 7, y: 3 }); // halfway, depth 1
    finishWith(g, 1, { x: 4, y: 5 }, { x: 8, y: 5 }); // halfway, depth 2

    resolveRound(g);
    expect(g.players[1].place).toBe(1);
    expect(g.players[0].place).toBe(2);
  });

  it('same moment and same depth is a tie, and the next car gets the shifted place', () => {
    const g = newGame(ringTrack(), 3);
    finishWith(g, 0, { x: 4, y: 3 }, { x: 8, y: 3 }); // halfway, depth 2
    finishWith(g, 1, { x: 4, y: 5 }, { x: 8, y: 5 }); // halfway, depth 2
    finishWith(g, 2, { x: 2, y: 6 }, { x: 9, y: 6 }); // four sevenths in, depth 3

    resolveRound(g);
    expect(g.players[0].place).toBe(1);
    expect(g.players[1].place).toBe(1);
    expect(g.players[2].place).toBe(3); // "1224" scoring: two firsts, then third
    expect(g.winner).toBe('draw');
  });

  it('a car dragged out of the gravel across the line loses to one that drove across', () => {
    // Same setup as the returnFromPenalty fixture above: the cells behind and on
    // the line are taken, so the return teleport lands seat 0 at (7,1), past it.
    const g = newGame(ringTrack(), 4);
    g.players[1].pos = { x: 4, y: 1 };
    g.players[2].pos = { x: 5, y: 1 };
    g.players[3].pos = { x: 6, y: 1 };
    g.players[0].pos = { x: 5.5, y: 0.4 };
    g.players[0].crossings = g.rules.winCrossings - 1;
    returnFromPenalty(g, 0);
    expect(g.players[0].crossings).toBe(g.rules.winCrossings);
    g.roundFinishers.push(0);

    // Seat 1 drives across under its own power and stops SHALLOWER than the
    // teleported car — under the old depth rule it would have lost.
    finishWith(g, 1, { x: 5, y: 3 }, { x: 6.5, y: 3 });
    expect(g.players[1].finishOvershoot!).toBeLessThan(g.players[0].finishOvershoot!);

    resolveRound(g);
    expect(g.players[1].place).toBe(1);
    expect(g.players[0].place).toBe(2);
  });
});
