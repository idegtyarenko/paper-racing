// Pacing of bot moves — pure, shared by both schedulers: the local one
// (main.ts) and the host's online one (online/host-bots.ts). Lives outside
// config.ts, which holds tunable constants only.

import { AI_MOVE_DELAY_MS, AI_MOVE_DELAY_MIN_MS, AI_STREAK_DECAY } from './config';

/**
 * Pause before a bot's move, given how many bots have already moved in this
 * unbroken run (0 = the first bot after a human). The first bot still gets the
 * full pause so the human can follow it; the tail of a long run flies by:
 * 600 → 360 → 216 → 180 → 180.
 */
export function botMoveDelayMs(streakIndex: number): number {
  const decayed = AI_MOVE_DELAY_MS * AI_STREAK_DECAY ** streakIndex;
  return Math.round(Math.max(AI_MOVE_DELAY_MIN_MS, decayed));
}
