// When a bot moves in a LOCAL game — the clock, not the driving. Which move a
// bot makes is model/ai's job; this module decides when it happens and keeps
// the three timers that answer that.
//
// Split out of main.ts (which had grown into a god-module): the composition
// root shouldn't own a schedule.
//
// Why not in model/ai/, next to chooseMove: the model layer has no DOM and no
// clock, which is what keeps it testable (ai.test.ts). This needs
// window.setTimeout, the gesture state from view/input, the session mode from
// online/ and write access to the app state — so it lives outside, the same way
// the host's online twin lives in online/host-bots.ts rather than in the model.
// The pure half — how long the pause is — is pacing.ts next door.

import type { AppState } from '../app-state';
import { applyMove, coastMove } from '../model/turns';
import { chooseMove } from '../model/ai';
import { isBotSeat } from '../seats';
import { AI_GESTURE_MAX_DEFER_MS } from '../config';
import { botMoveDelayMs } from './pacing';

export interface BotSchedulerDeps {
  /** The shared app state, by reference (read and mutated in place). */
  state: AppState;
  /** Is the board under a finger right now (view/input)? */
  isGesturing: () => boolean;
  /** Is this an online game? There the host commits bot moves, not us. */
  onlineActive: () => boolean;
  /** State changed — bring the screen up to date (and schedule the next move). */
  commit: () => void;
}

let deps: BotSchedulerDeps;

export function initBotScheduler(d: BotSchedulerDeps): void {
  deps = d;
}

/** Timer for the delayed bot move — not app state, just a handle: stays private
 *  to this module. Cleared on any exit from the race. */
let aiTimer: number | null = null;
/** How many bots have already moved in the current unbroken run — the pause
 *  shrinks with each one (botMoveDelayMs). Reset the moment the turn is back
 *  with a human, and on any exit from the race. */
let aiStreak = 0;
/** Timer that lets a bot move through even though the field is still under a
 *  finger — the way out of a gesture whose end never arrived (see
 *  AI_GESTURE_MAX_DEFER_MS). Null whenever nothing is being held back. */
let aiDeferTimer: number | null = null;

/** Stop the bots: no move pending, and the next one waits the full pause. */
export function cancelBotMoves(): void {
  clearAiTimers();
  aiStreak = 0;
}

/** Drop both ways into the next bot move — the pause and the gesture safety
 *  net — without touching the run counter. */
function clearAiTimers(): void {
  if (aiTimer !== null) {
    clearTimeout(aiTimer);
    aiTimer = null;
  }
  if (aiDeferTimer !== null) {
    clearTimeout(aiDeferTimer);
    aiDeferTimer = null;
  }
}

/**
 * Play one bot move: plan it, apply it, bring the screen up to date. Split out
 * of the timer below because the move has two ways in — the pause running out,
 * and the safety timer that lets it through when a gesture won't end. Whichever
 * gets here first drops the other, or a hand let go a moment before the safety
 * timer would fire buys two moves back to back with no pause between them.
 * Either way commit() schedules the next one properly.
 */
function runBotMove(): void {
  clearAiTimers();
  const S = deps.state;
  if (
    !S.game ||
    S.game.phase !== 'race' ||
    !isBotSeat(S.game, S.game.current) ||
    !S.raceNav
  )
    return;
  aiStreak++; // counted here, not when the pause was set: a move held back by a gesture hasn't been made yet
  const cand = chooseMove(S.game, S.raceNav, S.game.players[S.game.current].bot!);
  if (cand) applyMove(S.game, cand);
  else coastMove(S.game); // all candidates are taken by opponents — coast instead
  deps.commit();
}

/**
 * Bot-move loop for a LOCAL game: if it's currently a bot's turn, make its
 * move after a short pause (giving the human time to follow along), and keep
 * going until the turn returns to a human or the race ends. The pause shrinks
 * with every next bot in the run (botMoveDelayMs) — with 4–5 bots a full pause
 * each would leave the human waiting through five of them in a row. Doesn't run in
 * online games — there, bot moves are computed and committed by the host
 * through online-controller (otherwise the local applyMove would diverge
 * from the server). The pause is cleared on any exit from the race
 * (cancelBotMoves).
 */
export function scheduleBotMove(): void {
  const S = deps.state;
  if (aiTimer !== null || deps.onlineActive()) return;
  // Mode gate: bots only move during an actually open race. While the setup
  // screen is open (phase !== 'race'), bots are paused even if game is still
  // in phase 'race'. Without this check, commit() from menu transitions
  // would trigger a bot move behind the setup screen.
  if (
    S.phase !== 'race' ||
    !S.game ||
    S.game.phase !== 'race' ||
    !isBotSeat(S.game, S.game.current)
  ) {
    aiStreak = 0; // the run is over (or never started) — the next bot waits the full pause
    return;
  }
  const delay = botMoveDelayMs(aiStreak);
  aiTimer = window.setTimeout(() => {
    aiTimer = null;
    // The map is under a finger: planning the move would own the thread for
    // long enough to tear the drag, so the bot waits its turn out. Once the
    // hand comes off, gestureEnded schedules it again.
    if (deps.isGesturing()) {
      if (aiDeferTimer === null) {
        aiDeferTimer = window.setTimeout(runBotMove, AI_GESTURE_MAX_DEFER_MS);
      }
      return;
    }
    runBotMove();
  }, delay);
}
