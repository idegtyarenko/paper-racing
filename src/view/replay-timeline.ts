// Turning a finished race back into a race: the schedule the replay plays.
//
// The whole thing hangs on one idea — a ROUND, one move by everybody, is a beat.
// Every car's move for round r happens between beat r and beat r+1, so the cars
// move at once, at their own speeds, the way they would have if the race had
// been driven in real time instead of turn by turn. Which round a segment
// belongs to comes from its turn stamp (model/game.ts): turns burned in the
// gravel are gaps in a car's stamps, and a gap is a car standing still.
//
// Pure, and tested as such: no canvas, no DOM, no clock. The clock lives in
// replay-player.ts, which asks for a frame at time t.

import { Vec, lerp } from '../geometry';
import { GameState, TrailSeg } from '../model/game';
import { MotionFrame } from './render';

/** How far the already-driven trails are pushed back behind the moving cars. */
export const REPLAY_TRAIL_DIM = 0.45;

/** One car's move in one round. */
export interface ReplayHop {
  seat: number;
  /** Index of this segment in the player's trail. */
  segIndex: number;
  round: number;
  from: Vec;
  to: Vec;
  /** Teleport back onto the track after a penalty — instant, never in-between. */
  jump: boolean;
}

export interface ReplayTimeline {
  hops: ReplayHop[];
  /** The same hops per seat, in trail order. */
  bySeat: ReplayHop[][];
  /** Beats to play: the race ends at t === rounds. */
  rounds: number;
}

/**
 * Schedule a finished race. Segments written before turn stamps existed (an old
 * saved snapshot) have none, in which case every car's segments are played one
 * per round — the cars drift apart from how the race actually went, but the
 * button still does something, which beats hiding it.
 */
export function buildTimeline(game: GameState): ReplayTimeline {
  const n = game.players.length;
  const stamped = game.players.every((p) =>
    p.trail.every((s: TrailSeg) => typeof s.turn === 'number'),
  );
  const bySeat: ReplayHop[][] = game.players.map((p, seat) =>
    p.trail.map((s, segIndex) => ({
      seat,
      segIndex,
      round: stamped ? Math.floor(s.turn / n) : segIndex,
      from: s.from,
      to: s.to,
      jump: s.jump,
    })),
  );
  const hops = bySeat.flat();
  const rounds = hops.reduce((m, h) => Math.max(m, h.round + 1), 0);
  return { hops, bySeat, rounds };
}

/**
 * The frame at beat `t` (fractional): where every car is and how much of its
 * trail it has drawn by then. Motion inside a round is linear — between two
 * nodes the car IS travelling at a constant speed, and easing every move would
 * turn a lap into a series of lurches.
 */
export function sampleTimeline(
  tl: ReplayTimeline,
  game: GameState,
  t: number,
): MotionFrame {
  const round = Math.floor(t);
  const frac = t - round;
  const pos: (Vec | null)[] = [];
  const segsShown: (number | null)[] = [];
  const partialTo: (Vec | null)[] = [];
  const crashesShown: (number | null)[] = [];

  game.players.forEach((p, seat) => {
    const hops = tl.bySeat[seat];
    const done = hops.filter((h) => h.round < round);
    const now = hops.find((h) => h.round === round) ?? null;

    if (now && !now.jump) {
      const at = lerp(now.from, now.to, frac);
      pos[seat] = at;
      partialTo[seat] = at;
      segsShown[seat] = now.segIndex;
    } else if (now) {
      // A teleport has no middle: the car spends the whole round at the far end.
      pos[seat] = now.to;
      partialTo[seat] = null;
      segsShown[seat] = now.segIndex + 1;
    } else {
      const last = done[done.length - 1] ?? null;
      pos[seat] = last ? last.to : (hops[0]?.from ?? p.pos);
      partialTo[seat] = null;
      segsShown[seat] = done.length;
    }

    // A crash mark belongs to the segment that ends in it, so it appears the
    // moment the car gets there and not a round early.
    const reached = now && now.jump ? [...done, now] : done;
    crashesShown[seat] = p.crashes.filter((c) =>
      reached.some((h) => h.to.x === c.x && h.to.y === c.y),
    ).length;
  });

  return { pos, segsShown, partialTo, crashesShown, trailDim: REPLAY_TRAIL_DIM };
}
