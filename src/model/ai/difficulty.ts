// Bot-strength levers: difficulty levels and their search parameters. Pure data, no DOM.

export type Difficulty = 'easy' | 'medium' | 'hard';

/** A* planner settings — the shared search engine behind every difficulty level. */
export interface PlanParams {
  /** Cap on A* node expansions: higher means a farther-sighted, more optimal plan. */
  budget: number;
  /** Reference speed: converts "cells to the finish" into "moves" for the heuristic. */
  vref: number;
  /** Heuristic weight (>1 is greedier toward the finish): fewer expansions, slightly
   *  less optimal. */
  weight: number;
}

/** Bot-strength levers — see the DIFFICULTY table. Every level runs the same A*
 *  search; they only differ in how much it's "weakened": horizon (budget),
 *  greediness (weight), speed cap (maxSpeed), selection noise (epsilon), and the
 *  braking invariant (enforceStop). */
export interface DifficultyParams {
  /** Recursion cap for canStop; at the limit we optimistically assume it'll manage. */
  stopCap: number;
  /** Soft speed cap: exceeding it is penalized, not forbidden. */
  maxSpeed: number;
  /** Probability of picking a random near-best move (variety without jitter). */
  epsilon: number;
  /** Whether to enforce the safety invariant (prefer roots we can brake from). false
   *  for easy — it drives on the edge and sometimes fails to brake in time
   *  (intentional crashes). */
  enforceStop: boolean;
  /** A* search parameters. */
  plan: PlanParams;
}

// Every level plans on time (A*), not on path. Values are calibrated on a dense
// slalom track: on an open track medium runs ~18% and easy ~42% more moves per lap
// than hard's optimum (on tight tracks the levels converge, since the speed cap
// stops being the binding constraint). hard is optimal and drives clean; medium is
// careful; easy is noticeably slower, shorter-sighted, and occasionally crashes
// (enforceStop=false → it occasionally fails to brake in time, roughly once every
// few races, at most one crash). The search runs in single-to-low-double-digit
// milliseconds per move (hidden behind the AI_MOVE_DELAY_MS=600 pause).
export const DIFFICULTY: Record<Difficulty, DifficultyParams> = {
  easy: {
    stopCap: 6,
    maxSpeed: 4,
    epsilon: 0.12,
    enforceStop: false,
    plan: { budget: 500, vref: 2.5, weight: 1.9 },
  },
  medium: {
    stopCap: 8,
    maxSpeed: 5,
    epsilon: 0.08,
    enforceStop: true,
    plan: { budget: 1200, vref: 2.5, weight: 1.6 },
  },
  hard: {
    stopCap: 12,
    maxSpeed: Infinity,
    epsilon: 0,
    enforceStop: true,
    plan: { budget: 4000, vref: 2.5, weight: 1.2 },
  },
};
