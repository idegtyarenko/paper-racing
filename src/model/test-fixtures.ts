// Test fixtures for the pure core. Not part of the bundle (only *.test.ts files
// import them). Builds a real track through finalizeTrack so inside/startPoints
// are computed by the actual logic instead of being hand-faked.

import { Vec, Polyline } from '../geometry';
import { Track, finalizeTrack } from './track';
import { GameState, Rules, newGame } from './game';

/**
 * A rectangular "ring" (donut): the road is the band between an outer and an
 * inner rectangle. The bottom straight (y ~ 1..7, x ~ 1..39) is a wide corridor
 * with plenty of grid nodes, convenient for deterministic move/crash geometry.
 * The finish crosses the bottom straight at x=6, and the race runs in +x
 * (forward = {1,0}), so sideOfFinish(p) = p.x - 6: starting positions (behind)
 * are to the left of the line.
 */
export const OUTER: Polyline = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 24 },
  { x: 0, y: 24 },
];
export const INNER: Polyline = [
  { x: 8, y: 8 },
  { x: 32, y: 8 },
  { x: 32, y: 16 },
  { x: 8, y: 16 },
];
export const FINISH = { a: { x: 6, y: 0 }, b: { x: 6, y: 8 } };
export const FORWARD: Vec = { x: 1, y: 0 };

export function ringTrack(): Track {
  const res = finalizeTrack(OUTER, INNER, FINISH, FORWARD);
  if ('error' in res) throw new Error(`ringTrack fixture invalid: ${res.error}`);
  return res.track;
}

export function gameOn(track: Track, players = 2, rules?: Rules): GameState {
  return newGame(track, players, rules);
}
