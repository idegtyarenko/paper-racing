// Live computation of car standings (who's in what position right now) for an
// F1-style standings bar. Pure logic, no DOM; reuses the bot navigation field
// (buildNavField/navAt) as an estimate of "how far is there still left to the finish".

import { GameState, WIN_CROSSINGS } from './game';
import { NavField, navAt } from './nav';

/**
 * A car's remaining distance to victory in field "steps": laps not yet
 * completed plus the distance to the nearest finish. Smaller means closer to
 * winning. A car that already crossed the finish in the current (not yet
 * resolved) round gets a negative term for the "extra" lap, correctly placing
 * it ahead of everyone still racing.
 */
function remaining(state: GameState, nav: NavField, seat: number): number {
  const p = state.players[seat];
  return (WIN_CROSSINGS - 1 - p.crossings) * nav.lap + navAt(nav, p.pos);
}

/**
 * Order of cars from 1st place to last for the standings bar:
 *  1) already placed (finished in a resolved round) — ordered by place;
 *  2) still racing — ordered by remaining distance to the finish (closer ranks higher);
 *  3) retired — at the end, in seat order.
 * Returns player indices (seats).
 */
export function computeStandings(state: GameState, nav: NavField): number[] {
  const seats = state.players.map((_, i) => i);
  const rank = (i: number): [number, number] => {
    const p = state.players[i];
    if (p.place !== null) return [0, p.place];
    if (p.retired) return [2, i];
    return [1, remaining(state, nav, i)];
  };
  return seats.sort((a, b) => {
    const [ga, va] = rank(a);
    const [gb, vb] = rank(b);
    return ga !== gb ? ga - gb : va - vb;
  });
}
