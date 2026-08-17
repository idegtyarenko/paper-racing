import { describe, it, expect } from 'vitest';
import {
  Rules,
  DEFAULT_RULES,
  crashPenalty,
  newGame,
  shuffledIndices,
  cloneState,
  returnFromPenalty,
  isFinished,
  humansAllDone,
  hasLiveBots,
  lapStartIndex,
} from './game';
import { CRASH_PENALTY_MAX } from '../config';
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
