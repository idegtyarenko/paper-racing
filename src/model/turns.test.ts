import { describe, it, expect } from 'vitest';
import { newGame, cloneState, Candidate, Drive, Player, DEFAULT_RULES } from './game';
import {
  candidates,
  candidatesForSeat,
  applyMove,
  coastMove,
  playerForTurn,
  upcomingTurns,
  upcomingSlots,
  retireSeat,
  reachableTargets,
  forwardCap,
  canFinishThisTurn,
} from './turns';
import { turnsTaken } from './standings';
import { WIN_CROSSINGS, DRIVE_PRESETS } from '../config';
import { key } from './track';
import { ringTrack } from './test-fixtures';

const cand = (x: number, y: number): Candidate => ({
  target: { x, y },
  crash: false,
  blockReason: null,
  blocked: false,
  inertial: false,
});

/** Places a player at a known point on the track with a given velocity. */
function place(p: Player, pos: [number, number], vel: [number, number] = [0, 0]): void {
  p.pos = { x: pos[0], y: pos[1] };
  p.vel = { x: vel[0], y: vel[1] };
}

describe('candidates', () => {
  // Classic handling (isotropic 3×3 square) — set explicitly, since the default
  // is now the realistic model (traction ellipse).
  const classicGame = () =>
    newGame(ringTrack(), 2, { ...DEFAULT_RULES, drive: { ...DRIVE_PRESETS.classic } });

  it('returns 9 candidates, exactly one inertial with target = pos + vel', () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [2, 1]);
    const cs = candidates(g);
    expect(cs).toHaveLength(9);
    const inertial = cs.filter((c) => c.inertial);
    expect(inertial).toHaveLength(1);
    expect(inertial[0].target).toEqual({ x: 12, y: 5 });
  });

  it('flags crash when a move goes past the wall beyond tolerance', () => {
    const g = classicGame();
    place(g.players[0], [10, 2], [0, -2]); // base (10,0), the bottom row of targets goes past y=0
    const cs = candidates(g);
    const belowWall = cs.filter((c) => c.target.y === -1);
    expect(belowWall).toHaveLength(3);
    expect(belowWall.every((c) => c.crash)).toBe(true);
    expect(cs.filter((c) => c.target.y === 1).every((c) => !c.crash)).toBe(true);
  });

  it('is blocked when an opponent occupies the target cell', () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [2, 0]);
    place(g.players[1], [13, 4]); // target (13,4) under acceleration (1,0)
    const c = candidates(g).find((c) => c.target.x === 13 && c.target.y === 4)!;
    expect(c.blocked).toBe(true);
    expect(c.blockReason).toBe('occupied');
  });

  it('is blocked when an opponent sits on the move path (driving "through" is not allowed)', () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [2, 0]);
    place(g.players[1], [11, 4]); // on the segment (10,4)→(12,4)
    const inertial = candidates(g).find((c) => c.inertial)!;
    expect(inertial.target).toEqual({ x: 12, y: 4 });
    expect(inertial.blocked).toBe(true);
    expect(inertial.blockReason).toBe('path');
  });

  // Occupancy wins over the path reason: the target cell itself is what the
  // player sees, and a car is already drawn there.
  it('a car on the target cell reports "occupied" even when one is also on the path', () => {
    const g = newGame(ringTrack(), 3, {
      ...DEFAULT_RULES,
      drive: { ...DRIVE_PRESETS.classic },
    });
    place(g.players[0], [10, 4], [2, 0]);
    place(g.players[1], [11, 4]); // on the segment
    place(g.players[2], [12, 4]); // on the target
    const inertial = candidates(g).find((c) => c.inertial)!;
    expect(inertial.target).toEqual({ x: 12, y: 4 });
    expect(inertial.blockReason).toBe('occupied');
  });

  it('an unblocked candidate has a null blockReason', () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [2, 0]);
    place(g.players[1], [20, 9]);
    const inertial = candidates(g).find((c) => c.inertial)!;
    expect(inertial.blocked).toBe(false);
    expect(inertial.blockReason).toBeNull();
  });

  it('an opponent serving a penalty (skipTurns>0) does not block', () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [2, 0]);
    place(g.players[1], [11, 4]);
    g.players[1].skipTurns = 1;
    const inertial = candidates(g).find((c) => c.inertial)!;
    expect(inertial.blocked).toBe(false);
  });

  it('at start (vel = 0) classic mode gives a 3×3 square with diagonals', () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [0, 0]);
    const cs = candidates(g);
    expect(cs).toHaveLength(9);
    // diagonal move is available
    expect(cs.some((c) => c.target.x === 11 && c.target.y === 5)).toBe(true);
  });

  // The "stay put" move is a zero-length segment. A degenerate pointOnSegment
  // used to report every opponent as lying on it, so standing still was blocked
  // by any car anywhere on the track.
  it('staying put (target = pos) is not blocked by a distant opponent', () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [0, 0]);
    place(g.players[1], [20, 9]); // nowhere near (10,4)
    const stay = candidates(g).find((c) => c.target.x === 10 && c.target.y === 4)!;
    expect(stay).toBeDefined();
    expect(stay.blocked).toBe(false);
  });
});

describe('candidatesForSeat — fan-out for a non-active seat (pre-selection)', () => {
  const classicGame = () =>
    newGame(ringTrack(), 2, { ...DEFAULT_RULES, drive: { ...DRIVE_PRESETS.classic } });

  it("computes from the given seat's pos/vel, not the current one", () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [0, 0]); // current, but we care about seat 1
    place(g.players[1], [20, 6], [2, 1]);
    const cs = candidatesForSeat(g, 1);
    expect(cs).toHaveLength(9);
    const inertial = cs.filter((c) => c.inertial);
    expect(inertial).toHaveLength(1);
    expect(inertial[0].target).toEqual({ x: 22, y: 7 }); // pos + vel of seat 1
  });

  it("accounts for other seats' positions when checking blocked (current player on the path)", () => {
    const g = classicGame();
    place(g.players[1], [10, 4], [2, 0]);
    place(g.players[0], [11, 4]); // opponent (current player) on the segment (10,4)→(12,4)
    const inertial = candidatesForSeat(g, 1).find((c) => c.inertial)!;
    expect(inertial.target).toEqual({ x: 12, y: 4 });
    expect(inertial.blocked).toBe(true);
  });

  it('candidates(state) is equivalent to candidatesForSeat(state, current)', () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [1, -1]);
    expect(candidatesForSeat(g, g.current)).toEqual(candidates(g));
  });
});

describe('candidates — realistic physics (traction ellipse)', () => {
  const D = DRIVE_PRESETS.sports; // downforce 0 → aero = 1, purely mechanical ellipse
  /** Game with realistic handling. */
  const realGame = () => newGame(ringTrack(), 2, { ...DEFAULT_RULES, drive: { ...D } });
  /** Candidate acceleration a = target − (pos + vel). */
  const accelOf = (c: Candidate, p: Player) => ({
    x: c.target.x - p.pos.x - p.vel.x,
    y: c.target.y - p.pos.y - p.vel.y,
  });
  /** Whether acceleration a lies inside the traction ellipse at velocity vel. */
  function inEllipse(
    a: { x: number; y: number },
    vel: { x: number; y: number },
  ): boolean {
    const speed = Math.hypot(vel.x, vel.y);
    const ux = vel.x / speed;
    const uy = vel.y / speed;
    const along = a.x * ux + a.y * uy;
    const lat = -a.x * uy + a.y * ux;
    const cap = along >= 0 ? forwardCap(D.accel) : D.brake;
    return (along / cap) ** 2 + (lat / D.grip) ** 2 <= 1 + 1e-9;
  }
  /** Largest turn (angle between old and new velocity) among the candidates. */
  function maxTurn(g: ReturnType<typeof realGame>): number {
    const p = g.players[0];
    let max = 0;
    for (const c of candidates(g)) {
      const nv = { x: c.target.x - p.pos.x, y: c.target.y - p.pos.y };
      if (nv.x === 0 && nv.y === 0) continue;
      const cross = p.vel.x * nv.y - p.vel.y * nv.x;
      const dot = p.vel.x * nv.x + p.vel.y * nv.y;
      max = Math.max(max, Math.abs(Math.atan2(cross, dot)));
    }
    return max;
  }

  it('targets are integer-valued and inside the traction ellipse, exactly one inertial', () => {
    const g = realGame();
    place(g.players[0], [10, 4], [3, 0]);
    const p = g.players[0];
    const cs = candidates(g);
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.filter((c) => c.inertial)).toHaveLength(1);
    for (const c of cs) {
      expect(Number.isInteger(c.target.x)).toBe(true);
      expect(Number.isInteger(c.target.y)).toBe(true);
      expect(inEllipse(accelOf(c, p), p.vel)).toBe(true);
    }
  });

  it('the inertial candidate is the coast point pos + vel (a = 0)', () => {
    const g = realGame();
    place(g.players[0], [10, 4], [2, 1]);
    const inertial = candidates(g).find((c) => c.inertial)!;
    expect(inertial.target).toEqual({ x: 12, y: 5 });
  });

  it('at start (vel = 0) a diagonal move is available — the full 3×3 set', () => {
    const g = realGame();
    place(g.players[0], [10, 4], [0, 0]);
    const targets = candidates(g)
      .map((c) => `${c.target.x},${c.target.y}`)
      .sort();
    const expected: string[] = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) expected.push(`${10 + dx},${4 + dy}`);
    expect(targets).toEqual(expected.sort());
  });

  it('brakes faster than it accelerates: reaches further backward than forward', () => {
    expect(D.accel).toBeLessThan(D.brake); // premise of the asymmetry
    const g = realGame();
    place(g.players[0], [10, 4], [3, 0]); // moving right, longitudinal axis = x
    const p = g.players[0];
    const speeds = candidates(g).map((c) => c.target.x - p.pos.x); // new speed along direction of travel
    const base = p.vel.x;
    // Forward and backward — the furthest node inside each cap. Forward the cap
    // is forwardCap (accel floored at the lattice diagonal), so the last node
    // that fits is 1, not 2.
    expect(Math.max(...speeds) - base).toBe(Math.floor(forwardCap(D.accel)));
    expect(base - Math.min(...speeds)).toBe(D.brake); // backward — exactly the braking cap
  });

  // What separates "sports" from "classic" now that the forward semi-axis is
  // floored: at these sizes grip is the only axis that can bend the fan away
  // from a plain 3×3 square, so sports grips less sideways and loses the
  // corners of the square — throttle and steering can't go into one move.
  it('sports cannot add speed and turn in the same move, classic can', () => {
    const cornerTargets = (drive: Drive): string[] => {
      const g = newGame(ringTrack(), 2, { ...DEFAULT_RULES, drive: { ...drive } });
      place(g.players[0], [10, 4], [4, 0]); // moving right: a corner is (+1, ±1)
      const p = g.players[0];
      return candidates(g)
        .filter(
          (c) => c.target.x === p.pos.x + p.vel.x + 1 && c.target.y !== p.pos.y + p.vel.y,
        )
        .map((c) => `${c.target.x},${c.target.y}`);
    };
    expect(cornerTargets(D)).toEqual([]);
    expect(cornerTargets(DRIVE_PRESETS.classic).length).toBeGreaterThan(0);
  });

  it('on a diagonal heading, accelerating straight ahead is available (lattice floor)', () => {
    // accel = 1 is shorter than the lattice diagonal √2, so without the floor
    // the only speed-gaining nodes on a 45° heading are off-axis ones — the
    // fan looked wider sideways than forward. With the floor, a = (1,1) fits.
    const g = realGame();
    place(g.players[0], [10, 4], [3, 3]);
    const targets = candidates(g).map((c) => `${c.target.x},${c.target.y}`);
    expect(targets).toContain('14,8'); // pos + vel + (1,1): straight on, faster
  });

  it('every heading has a candidate that is strictly forward and faster', () => {
    // The invariant the floor buys: whatever direction you travel in, "more
    // throttle, same course" is a move you can actually pick — no lattice
    // heading is forced to turn in order to gain speed.
    for (const vel of [
      [3, 0],
      [0, 3],
      [3, 3],
      [-2, 2],
    ] as [number, number][]) {
      const g = realGame();
      place(g.players[0], [10, 4], vel);
      const p = g.players[0];
      const speed = Math.hypot(vel[0], vel[1]);
      const straightFaster = candidates(g).some((c) => {
        const nv = { x: c.target.x - p.pos.x, y: c.target.y - p.pos.y };
        const cross = vel[0] * nv.y - vel[1] * nv.x; // zero → same course
        return cross === 0 && Math.hypot(nv.x, nv.y) > speed;
      });
      expect(straightFaster, `heading ${vel}`).toBe(true);
    }
  });

  it('the higher the speed, the smaller the maximum turn per move', () => {
    const slow = realGame();
    place(slow.players[0], [10, 4], [2, 0]);
    const fast = realGame();
    place(fast.players[0], [10, 4], [5, 0]);
    expect(maxTurn(fast)).toBeLessThan(maxTurn(slow));
  });
});

describe('reachableTargets — aerodynamic downforce', () => {
  const pos = { x: 0, y: 0 };
  const noAero = { accel: 1, brake: 2, grip: 2, downforce: 0 };
  const withAero = { ...noAero, downforce: 1 };
  const keys = (vel: { x: number; y: number }, d: typeof noAero) =>
    reachableTargets(pos, vel, d).map((t) => `${t.x},${t.y}`);

  it('at speed, downforce only expands the reachable area: old nodes remain, new ones appear', () => {
    const vel = { x: 4, y: 0 }; // reference speed: aero = 1 + 1·(4/4)² = 2
    const base = new Set(keys(vel, noAero));
    const boosted = new Set(keys(vel, withAero));
    for (const k of base) expect(boosted.has(k)).toBe(true); // downforce only adds grip
    expect(boosted.size).toBeGreaterThan(base.size); // strictly wider
  });

  it('at zero speed, downforce changes nothing (aero = 1)', () => {
    const vel = { x: 0, y: 0 };
    expect(keys(vel, withAero).sort()).toEqual(keys(vel, noAero).sort());
  });
});

describe('applyMove — regular move', () => {
  it('updates pos, vel, appends to the trail, and passes the turn', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 4], [1, 0]);
    applyMove(g, cand(11, 4));
    const p = g.players[0];
    expect(p.pos).toEqual({ x: 11, y: 4 });
    expect(p.vel).toEqual({ x: 1, y: 0 });
    expect(p.trail).toHaveLength(1);
    expect(p.trail[0]).toMatchObject({ jump: false });
    expect(g.current).toBe(1);
  });

  it('is a no-op for a blocked candidate', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 4]);
    const before = JSON.stringify(g.players[0]);
    applyMove(g, { ...cand(11, 4), blocked: true });
    expect(JSON.stringify(g.players[0])).toBe(before);
    expect(g.current).toBe(0); // turn did not pass
  });

  it('is a no-op in the over phase', () => {
    const g = newGame(ringTrack(), 2);
    g.phase = 'over';
    place(g.players[0], [10, 4]);
    applyMove(g, cand(11, 4));
    expect(g.players[0].pos).toEqual({ x: 10, y: 4 });
  });
});

describe('applyMove — crash', () => {
  it('car stays in the gravel, speed resets to zero, a penalty is assigned, but it is NOT teleported back onto the track', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 1]);
    applyMove(g, cand(10, -2)); // through the bottom wall y=0; move length 3
    const p = g.players[0];
    expect(p.pos.x).toBeCloseTo(10);
    expect(p.pos.y).toBeLessThan(0); // stuck at the edge of the tolerance band, not inside
    expect(p.pos.y).toBeGreaterThan(-1);
    expect(p.vel).toEqual({ x: 0, y: 0 });
    expect(p.crashes).toHaveLength(1);
    expect(p.skipTurns).toBe(3); // crashPenalty(dynamic 1, speed 3) = 3
    expect(p.trail[0].jump).toBe(false);
  });
});

describe('applyMove — crossing the finish line', () => {
  it('a forward crossing of the line counts +1', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [5, 4]); // behind the line (x<6)
    applyMove(g, cand(7, 4)); // past the line (x>6)
    expect(g.players[0].crossings).toBe(1);
  });

  it('a backward crossing of the line counts −1', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [7, 4]);
    g.players[0].crossings = 1;
    applyMove(g, cand(5, 4));
    expect(g.players[0].crossings).toBe(0);
  });

  it('a move that does not cross the line leaves the counter unchanged', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [7, 4]);
    applyMove(g, cand(9, 4));
    expect(g.players[0].crossings).toBe(0);
  });
});

describe('turn order and serving a penalty', () => {
  it('a crashed car returns to the track ONLY once its penalty reaches zero', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 1]);
    applyMove(g, cand(10, -2)); // p0 in the gravel, skip=3, opponent to move
    const crashed = g.players[0];
    const gravel = { ...crashed.pos };
    expect(crashed.skipTurns).toBe(3);
    expect(g.current).toBe(1);

    // Play out turns: while the penalty is unpaid, it's always the other player's
    // turn (p0's skips burn down automatically inside afterAction). Invariant: while
    // skip>0, the crashed car stays in the gravel; at zero, it returns to the track.
    let guard = 0;
    while (crashed.skipTurns > 0 && guard++ < 20) {
      expect(g.current).not.toBe(0); // p0 is serving its penalty — opponent moves
      place(g.players[g.current], [20, 4], [0, 0]);
      applyMove(g, cand(20, 4));
      if (crashed.skipTurns > 0) expect(crashed.pos).toEqual(gravel);
    }
    expect(crashed.skipTurns).toBe(0);
    // once served — back on a track node (inside), with a dashed "teleport" jump.
    expect(g.track.inside.has(key(crashed.pos.x, crashed.pos.y))).toBe(true);
    expect(crashed.trail.some((s) => s.jump)).toBe(true);
  });

  it('every turn burned in the gravel is counted, so the final score shows the cost', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 1]);
    expect(g.players[0].penaltyTurns).toBe(0);
    applyMove(g, cand(10, -2)); // p0 in the gravel, skip=3
    const crashed = g.players[0];
    expect(crashed.penaltyTurns).toBe(0); // assigned, not yet served

    let guard = 0;
    while (crashed.skipTurns > 0 && guard++ < 20) {
      place(g.players[g.current], [20, 4], [0, 0]);
      applyMove(g, cand(20, 4));
    }
    // Three slots burned in the gravel — none of them pushed a trail segment.
    expect(crashed.penaltyTurns).toBe(3);
  });

  it('stamps every trail segment with its turn, so the gravel reads as a gap', () => {
    // The stamps are the only record of WHEN each segment was driven: the crash
    // penalty is computed from the intended target, which nothing keeps, so a
    // replay can't otherwise tell a car that sat out three rounds from one that
    // drove them. Rounds, not slots — a round is one move by everybody.
    const g = newGame(ringTrack(), 2);
    const round = (t: number) => Math.floor(t / g.players.length);
    place(g.players[0], [10, 1]);
    applyMove(g, cand(10, -2)); // p0 into the gravel, skip = 3
    const crashed = g.players[0];
    expect(crashed.trail[0].turn).toBe(0);

    let guard = 0;
    while (crashed.skipTurns > 0 && guard++ < 20) {
      place(g.players[g.current], [20, 4], [0, 0]);
      applyMove(g, cand(20, 4));
    }

    // Nothing was pushed while the penalty burned, and the teleport back onto the
    // track is stamped exactly three rounds after the crash.
    expect(crashed.trail).toHaveLength(2);
    const jump = crashed.trail[1];
    expect(jump.jump).toBe(true);
    expect(round(jump.turn) - round(crashed.trail[0].turn)).toBe(3);
  });
});

describe('fair turn rotation', () => {
  it('the starting player shifts each lap: A,B,C → B,C,A → C,A,B', () => {
    const order = (turn: number) => playerForTurn(turn, 3);
    expect([0, 1, 2].map(order)).toEqual([0, 1, 2]); // lap 1
    expect([3, 4, 5].map(order)).toEqual([1, 2, 0]); // lap 2
    expect([6, 7, 8].map(order)).toEqual([2, 0, 1]); // lap 3
    expect([9, 10, 11].map(order)).toEqual([0, 1, 2]); // cycle wraps back around
  });

  it('every lap is a permutation of all players (no one skipped or moved twice)', () => {
    for (let n = 2; n <= 6; n++) {
      for (let round = 0; round < 4; round++) {
        const seats = Array.from({ length: n }, (_, s) =>
          playerForTurn(round * n + s, n),
        );
        expect([...seats].sort((a, b) => a - b)).toEqual(
          Array.from({ length: n }, (_, i) => i),
        );
      }
    }
  });

  it('actual in-game moves follow the rotation (3 players, two laps)', () => {
    const g = newGame(ringTrack(), 3);
    // Spread the cars across different cells of the bottom corridor (y∈1..7) so
    // their moves don't block each other.
    g.players.forEach((p, i) => place(p, [20, 2 + i * 2], [0, 0]));
    const seen: number[] = [];
    for (let k = 0; k < 6; k++) {
      seen.push(g.current);
      const cur = g.players[g.current];
      place(cur, [10 + k, 3], [0, 0]); // a unique free cell for this move
      applyMove(g, cand(10 + k, 3));
    }
    expect(seen).toEqual([0, 1, 2, 1, 2, 0]);
  });

  it('the first lap follows the starting grid (pole moves before the second row)', () => {
    // startOrder — seat → grid position: seat 0 is in position 2 (back), seat 1 is on
    // pole, seat 2 is in the middle. The first lap should move front to back: 1,2,0.
    const g = newGame(ringTrack(), 3, DEFAULT_RULES, [2, 0, 1]);
    // The pole sitter (startPoints[0]) moves first, not seat 0.
    expect(g.current).toBe(1);
    expect(g.players[g.current].pos).toEqual(g.track.startPoints[0]);
    // Lap 1 follows the grid (1,2,0); lap 2 keeps the usual offset relative to the grid.
    expect(upcomingTurns(g, 6)).toEqual([1, 2, 0, 2, 0, 1]);
  });

  it('the grid preserves the 0,1,1,0 rotation for two players (a,b,b,a)', () => {
    // Pole goes to seat 1 (startOrder swaps the two) → sequence 1,0,0,1:
    // the same "blocking advantage" structure, just relative to the grid.
    const g = newGame(ringTrack(), 2, DEFAULT_RULES, [1, 0]);
    expect(g.current).toBe(1);
    expect(g.players[g.current].pos).toEqual(g.track.startPoints[0]);
    expect(upcomingTurns(g, 4)).toEqual([1, 0, 0, 1]);
  });
});

describe('upcomingTurns — queue of upcoming moves', () => {
  it('the first element is the current player; order follows the rotation', () => {
    const g = newGame(ringTrack(), 3);
    expect(upcomingTurns(g, 6)).toEqual([0, 1, 2, 1, 2, 0]); // matches actual moves
  });

  it('looks ahead from the current slot (turn != 0)', () => {
    const g = newGame(ringTrack(), 3);
    g.turn = 4;
    g.current = playerForTurn(4, 3); // keep the invariant current == playerForTurn(turn)
    expect(upcomingTurns(g, 4)).toEqual([2, 0, 2, 0]); // slots 4,5,6,7 = 2,0,2,0
  });

  it('a player in the pits (skipTurns) does not appear until the penalty is served', () => {
    const g = newGame(ringTrack(), 3);
    g.players[1].skipTurns = 2; // Blue is serving a two-move penalty
    // Slots rotate: 0,1,2,0(lap2 offset:1,2,0)… Blue (1) burns off slots 1 and 3.
    const q = upcomingTurns(g, 5);
    expect(q[0]).toBe(0);
    expect(q).not.toContain(1); // across the first five real moves Blue is still in the gravel/just returned
    // once the penalty is served, Blue reappears in the queue
    expect(upcomingTurns(g, 8)).toContain(1);
  });

  it('final lap: the queue is never longer than the slots remaining (finalTurnsLeft)', () => {
    const g = newGame(ringTrack(), 3);
    g.finalTurnsLeft = 2;
    expect(upcomingTurns(g, 9)).toHaveLength(2);
  });

  it("final lap: a pitted player's slot consumes the remainder and shortens the queue", () => {
    const g = newGame(ringTrack(), 3);
    g.finalTurnsLeft = 2;
    g.players[1].skipTurns = 1; // Blue (slot 1) is serving a penalty — its slot burns off
    // Slots 0,1: slot0 → Red moves (1 left), slot1 → Blue skips (0 left).
    expect(upcomingTurns(g, 9)).toEqual([0]);
  });

  it('is deterministic: does not mutate state', () => {
    const g = newGame(ringTrack(), 3);
    g.players[1].skipTurns = 2;
    const before = JSON.stringify(g);
    upcomingTurns(g, 12);
    expect(JSON.stringify(g)).toBe(before);
  });
});

describe('upcomingSlots — ignoreRoundCap (display-only full forecast)', () => {
  it('by default the decisive round still caps the queue', () => {
    const g = newGame(ringTrack(), 3);
    g.finalTurnsLeft = 2;
    expect(upcomingSlots(g, 9)).toHaveLength(2);
  });

  it('with ignoreRoundCap the queue keeps its full length past the round boundary', () => {
    const g = newGame(ringTrack(), 3);
    const free = upcomingSlots(g, 9, { ignoreRoundCap: true });
    g.finalTurnsLeft = 2;
    const capped = upcomingSlots(g, 9, { ignoreRoundCap: true });
    expect(capped).toHaveLength(9);
    // The rotation past the boundary is the plain forecast — as if no round were open.
    expect(capped).toEqual(free);
    expect(capped.map((s) => s.seat)).toEqual([0, 1, 2, 1, 2, 0, 2, 0, 1]);
    expect(capped.map((s) => s.round)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
  });

  it('with ignoreRoundCap penalty skips are still honoured', () => {
    const g = newGame(ringTrack(), 3);
    g.finalTurnsLeft = 1;
    g.players[1].skipTurns = 1; // Blue's next slot burns off
    const q = upcomingSlots(g, 4, { ignoreRoundCap: true }).map((s) => s.seat);
    expect(q).toEqual([0, 2, 1, 2]); // slot 1 (Blue) burns, Blue returns on the next lap
  });

  it('with ignoreRoundCap a finished field yields an empty queue instead of spinning', () => {
    const g = newGame(ringTrack(), 3);
    g.players[0].place = 1;
    g.players[1].place = 2;
    g.players[2].retired = true;
    expect(upcomingSlots(g, 9, { ignoreRoundCap: true })).toEqual([]);
  });
});

describe('multi-round finish, placements, and retiring', () => {
  it('the first to finish gets place 1 and is named winner, but the race continues', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [5, 4]);
    g.players[0].crossings = WIN_CROSSINGS - 1; // finishes on this move
    applyMove(g, cand(7, 4)); // crossings → WIN, overshoot = 1
    expect(g.players[0].crossings).toBe(WIN_CROSSINGS);
    expect(g.finalTurnsLeft).toBe(1); // round is open: the second player still has a move
    expect(g.phase).toBe('race');

    place(g.players[1], [10, 4]);
    applyMove(g, cand(13, 4)); // p1 didn't finish — the round resolves
    expect(g.players[0].place).toBe(1);
    expect(g.winner).toBe(0);
    expect(g.players[1].place).toBeNull();
    expect(g.phase).toBe('race'); // race continues until p1 finishes or retires
  });

  it('placements within a round go by overshoot depth, not move order', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [5, 4]);
    g.players[0].crossings = WIN_CROSSINGS - 1;
    applyMove(g, cand(7, 4)); // p0 moves first, overshoot 1
    place(g.players[1], [5, 4]);
    g.players[1].crossings = WIN_CROSSINGS - 1;
    applyMove(g, cand(9, 4)); // p1 overshoots deeper, overshoot 3
    expect(g.phase).toBe('over');
    expect(g.players[1].place).toBe(1); // deeper past the line → better place
    expect(g.players[0].place).toBe(2);
    expect(g.winner).toBe(1);
  });

  it('a tied overshoot within a round splits the place (1224): two seconds → next is fourth', () => {
    const g = newGame(ringTrack(), 4);
    [0, 1, 2, 3].forEach((i) => {
      place(g.players[i], [5, 4]);
      g.players[i].crossings = WIN_CROSSINGS - 1;
    });
    applyMove(g, cand(11, 4)); // p0 overshoot 5 → place 1
    applyMove(g, cand(9, 4)); // p1 overshoot 3
    applyMove(g, cand(9, 4)); // p2 overshoot 3 (ties p1)
    applyMove(g, cand(7, 4)); // p3 overshoot 1
    expect(g.phase).toBe('over');
    expect(g.players.map((p) => p.place)).toEqual([1, 2, 2, 4]);
    expect(g.winner).toBe(0);
  });

  it('a tie for 1st place within a round → winner draw', () => {
    const g = newGame(ringTrack(), 2);
    [0, 1].forEach((i) => {
      place(g.players[i], [5, 4]);
      g.players[i].crossings = WIN_CROSSINGS - 1;
    });
    applyMove(g, cand(7, 4)); // p0 overshoot 1
    applyMove(g, cand(7, 4)); // p1 overshoot 1 — tied
    expect(g.phase).toBe('over');
    expect(g.players[0].place).toBe(1);
    expect(g.players[1].place).toBe(1);
    expect(g.winner).toBe('draw');
  });

  it('retiring: the player drops out, the turn passes on, and it no longer appears in the queue', () => {
    const g = newGame(ringTrack(), 3);
    expect(g.current).toBe(0);
    retireSeat(g, g.current);
    expect(g.players[0].retired).toBe(true);
    expect(g.players[0].place).toBeNull();
    expect(g.phase).toBe('race');
    expect(g.current).not.toBe(0); // turn moved on
    expect(upcomingTurns(g, 6)).not.toContain(0);
  });

  it('retiring a car that is not currently moving (at any point) does not shift the turn, but removes it', () => {
    const g = newGame(ringTrack(), 3);
    expect(g.current).toBe(0);
    retireSeat(g, 2); // a non-active player retires
    expect(g.players[2].retired).toBe(true);
    expect(g.current).toBe(0); // turn stays with the current player
    expect(g.phase).toBe('race');
    expect(upcomingTurns(g, 6)).not.toContain(2);
  });

  it('everyone retiring → race ends with no winner', () => {
    const g = newGame(ringTrack(), 2);
    retireSeat(g, g.current); // p0
    retireSeat(g, g.current); // p1 — no active players left
    expect(g.phase).toBe('over');
    expect(g.winner).toBeNull();
  });

  it('after another player finishes, the remaining one can retire — race ends, winner is preserved', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [5, 4]);
    g.players[0].crossings = WIN_CROSSINGS - 1;
    applyMove(g, cand(7, 4)); // p0 finishes, round is open
    place(g.players[1], [10, 4]);
    applyMove(g, cand(13, 4)); // p1 without finishing → p0 place 1, winner 0, race continues
    expect(g.winner).toBe(0);
    expect(g.phase).toBe('race');
    expect(g.current).toBe(1); // p0 is out — p1's turn
    retireSeat(g, g.current); // p1 retires — no active players left
    expect(g.phase).toBe('over');
    expect(g.players[1].retired).toBe(true);
    expect(g.winner).toBe(0); // winner is not overwritten
  });
});

describe('coastMove', () => {
  it('a stationary car (vel 0) simply passes, with no degenerate trail entry', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 4], [0, 0]);
    coastMove(g);
    expect(g.players[0].trail).toHaveLength(0);
    expect(g.current).toBe(1);
    // The slot burned all the same — the classification has to know about it.
    expect(turnsTaken(g.players[0])).toBe(1);
  });

  it('a moving car coasts on by inertia (pos += vel)', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 4], [2, 0]);
    coastMove(g);
    expect(g.players[0].pos).toEqual({ x: 12, y: 4 });
  });

  it('when the inertial cell is occupied, speed resets to zero and the turn passes', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 4], [2, 0]);
    place(g.players[1], [12, 4]); // inertial target is occupied
    coastMove(g);
    expect(g.players[0].pos).toEqual({ x: 10, y: 4 }); // stayed in place
    expect(g.players[0].vel).toEqual({ x: 0, y: 0 });
    expect(g.current).toBe(1);
    expect(turnsTaken(g.players[0])).toBe(1);
  });

  it('is deterministic: two copies of the same state give identical results', () => {
    const base = newGame(ringTrack(), 2);
    place(base.players[0], [10, 4], [1, 1]);
    const a = cloneState(base);
    const b = cloneState(base);
    coastMove(a);
    coastMove(b);
    expect(JSON.stringify(a.players)).toBe(JSON.stringify(b.players));
  });
});

describe('canFinishThisTurn', () => {
  // Classic handling (3×3 square fan) so the reachable set is obvious by hand.
  const classicGame = (players = 2) =>
    newGame(ringTrack(), players, {
      ...DEFAULT_RULES,
      drive: { ...DRIVE_PRESETS.classic },
    });

  it('true on the last lap when the fan reaches past the line', () => {
    const g = classicGame();
    g.players[0].crossings = WIN_CROSSINGS - 1;
    place(g.players[0], [5, 4], [1, 0]); // coasts to x=6, the finish line itself
    place(g.players[1], [20, 20]); // out of the way
    expect(canFinishThisTurn(g, 0)).toBe(true);
  });

  it('false when the same fan still leaves laps to run', () => {
    const g = classicGame();
    g.players[0].crossings = WIN_CROSSINGS - 2;
    place(g.players[0], [5, 4], [1, 0]);
    place(g.players[1], [20, 20]);
    expect(canFinishThisTurn(g, 0)).toBe(false);
  });

  it('false when the line is nowhere near the fan', () => {
    const g = classicGame();
    g.players[0].crossings = WIN_CROSSINGS - 1;
    place(g.players[0], [20, 20], [1, 0]); // far side of the ring
    place(g.players[1], [5, 4]);
    expect(canFinishThisTurn(g, 0)).toBe(false);
  });

  it('false when every candidate past the line is blocked by another car', () => {
    const g = classicGame(4);
    g.players[0].crossings = WIN_CROSSINGS - 1;
    place(g.players[0], [4, 4], [1, 0]); // fan spans x = 4..6; only x=6 crosses
    place(g.players[1], [6, 3]);
    place(g.players[2], [6, 4]);
    place(g.players[3], [6, 5]);
    expect(canFinishThisTurn(g, 0)).toBe(false);
  });

  it('false for a car that has already finished', () => {
    const g = classicGame();
    g.players[0].crossings = WIN_CROSSINGS;
    place(g.players[0], [7, 4], [1, 0]);
    place(g.players[1], [20, 20]);
    expect(canFinishThisTurn(g, 0)).toBe(false);
  });
});
