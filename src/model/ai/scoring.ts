// Move scoring and selection: heuristic constants, root ranking, and epsilon-greedy
// selection. Shared with the planner (planner.ts). Pure logic, no DOM.

import { Candidate } from '../game';
import { DifficultyParams } from './difficulty';

// ── Scoring constants (algorithmic, not gameplay constants — hence here, not in config) ──
/** Penalty per cell over the soft speed cap. */
export const OVERSPEED_PENALTY = 8;
/** Moves within this margin of the best plan count as "near-best" (for epsilon selection). */
export const EPS_MARGIN = 3;

/** Result of ranking the root moves for a move-selection strategy. */
export interface Ranking {
  /** The strategy's optimal move — always returned except under epsilon variety. */
  best: Candidate;
  /** Finish/unavoidable-crash case — return best exactly, no epsilon substitution. */
  terminal: boolean;
  /** All root moves with a "cost" (lower is better): used for easy/medium epsilon
   *  selection. */
  scored: { c: Candidate; score: number }[];
}

/**
 * Picks a move from the ranked root moves: the best one (the strategy's optimum),
 * except for easy/medium, where with probability epsilon a random near-optimal move
 * is picked instead — variety without jitter. There's deliberately no pack
 * repulsion: opponents get routed around by the A* search itself (blocked moves are
 * filtered out in candidates, and the plan routes around them), whereas an artificial
 * proximity penalty made the bot yield the racing line to any opponent and cost it
 * ~40% of its pace. Cars separate on their own anyway: they start from different
 * cells, A* from different states produces different lines, and blocked cells split
 * them up at intersections.
 */
export function pickMove(
  rank: Ranking,
  P: DifficultyParams,
  rng: () => number,
): Candidate {
  const { best, terminal, scored } = rank;
  if (terminal) return best;
  if (P.epsilon > 0 && scored.length > 1) {
    let poolBest = scored[0].score;
    for (const s of scored) if (s.score < poolBest) poolBest = s.score;
    const near = scored.filter((s) => s.score <= poolBest + EPS_MARGIN);
    if (near.length > 1 && rng() < P.epsilon) {
      return near[Math.min(near.length - 1, Math.floor(rng() * near.length))].c;
    }
  }
  return best;
}
