// AI opponent: track navigation and move selection. Pure logic, no DOM.
//
// Navigation is a distance-to-finish field (BFS over the road nodes in track.inside,
// 8-connected): dist(cell) = number of moves at speed 1 to the next forward finish
// crossing (see nav.ts).
//
// Move selection depends on difficulty:
// Every level shares the same A* planner over (pos, vel) states, minimizing the
// NUMBER OF MOVES to the next forward finish crossing (see planner.ts). That's what
// produces the racing line and braking before corners. Levels differ only in how
// much they're "weakened": planning horizon, heuristic greediness, speed cap,
// selection noise, and the braking invariant (easy drives on the edge and
// occasionally crashes) — see the DIFFICULTY table.
//
// Opponents are only considered at the first ply (blocked moves are filtered out in
// candidates(): you can't land on or drive through an opponent's cell) — deeper
// plies ignore them since they'll have moved on by then, and if A*'s optimal cell is
// occupied it just plans around it. There's deliberately no artificial pack
// repulsion: a proximity penalty made the bot yield the racing line and cost it
// ~40% of its pace. Cars spread out on their own anyway — different starting cells
// lead to different A* lines, and blocked cells separate them at intersections.

import { GameState, Candidate } from '../game';
import { NavField } from '../nav';
import { candidates } from '../turns';
import { Difficulty, DIFFICULTY } from './difficulty';
import { scoreByPlan } from './planner';
import { pickMove } from './scoring';

export type { Difficulty };

/**
 * Choose the bot's move from candidates(state). Returns a non-blocked candidate;
 * null means a deadlock (all 9 cells occupied by opponents), and the caller should
 * fall back to coasting (coastMove). Opponents beyond the first ply are not
 * considered, since they'll have moved by then.
 */
export function chooseMove(
  state: GameState,
  nav: NavField,
  difficulty: Difficulty,
  rng: () => number = Math.random,
): Candidate | null {
  const P = DIFFICULTY[difficulty];
  const open = candidates(state).filter((c) => !c.blocked);
  if (open.length === 0) return null;

  // Rank the root moves: best is the strategy's optimal move, scored holds the
  // near-optimal ones (for easy/medium epsilon-variety), terminal marks a
  // finish/unavoidable-crash case.
  const rank = scoreByPlan(
    state,
    nav,
    open,
    P.plan,
    P.maxSpeed,
    P.stopCap,
    P.enforceStop,
  );

  return pickMove(rank, P, rng);
}
