// Live computation of car standings (who's in what position right now) for an
// F1-style standings bar. Pure logic, no DOM; reuses the bot navigation field
// (buildNavField/navAt) as an estimate of "how far is there still left to the finish".

import { GameState, Player } from './game';
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
  return (state.rules.winCrossings - 1 - p.crossings) * nav.lap + navAt(nav, p.pos);
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

/**
 * The car's total time in turns — the score of a paper race, and what the final
 * classification shows instead of a placing (the placing is already the row's
 * position). Three terms, because a turn doesn't always leave a mark: driven moves
 * come from the trail (every applied move pushes exactly one segment; the
 * teleport back onto the track after a crash is a `jump` and costs no move),
 * while turns burned in the gravel and turns given up standing still push nothing
 * at all and are counted on the player as they go. Dropping either of the last two
 * would make a crash — or a lap spent stuck in the pack — free by the final number,
 * and the count would then contradict the order of the rows it sits in: a car that
 * finished later could show fewer turns than one that finished ahead of it.
 */
export function turnsTaken(p: Player): number {
  return p.trail.filter((s) => !s.jump).length + p.penaltyTurns + p.stationaryTurns;
}
