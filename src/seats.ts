// Who is at the controls of this client — the predicates behind "show the
// candidate fan", "is this move ours to make" and "can we retire".
//
// Split out of main.ts, where they were the knottiest thing in the file and
// impossible to test: they asked the online session about itself from the
// inside. Here the whole local/online question is ONE explicit field, `mySeat`,
// so every predicate is pure and covered by seats.test.ts.
//
// Three modes have to come out right, and they differ in who "you" is:
//   online   — you are one seat (mySeat), and the others are other people;
//   vs bots  — you are the only human, so the fan is yours even on a bot's turn;
//   hotseat  — several humans share this screen, so there is no single "you"
//              and pre-picking is off.

import { Phase } from './app-state';
import { GameState, isFinished } from './model/game';

/**
 * Who this client is at the controls of. `mySeat` is our own seat in an online
 * game; `null` means a local game (hotseat or vs-bots), where the controls
 * belong to whoever's turn it is. In online without a seat of our own it stays
 * −1, the way session.mySeat() reports it.
 */
export interface SeatCtx {
  game: GameState | null;
  phase: Phase;
  mySeat: number | null;
}

/** Is this seat a bot (and at what difficulty)? Bot-ness lives in state (Player.bot). */
export function isBotSeat(game: GameState | null, seat: number): boolean {
  return !!game?.players[seat]?.bot;
}

/**
 * The one human seat in a local game (all others are bots): this is who we
 * show the candidate fan/pre-pick to during a bot's turn. −1 if there isn't
 * exactly one human (hotseat with multiple humans doesn't get pre-picking).
 * Online doesn't look at this.
 */
export function soloHumanSeat(game: GameState | null): number {
  if (!game) return -1;
  let seat = -1;
  for (let i = 0; i < game.players.length; i++) {
    if (game.players[i].bot) continue;
    if (seat !== -1) return -1; // a second human means hotseat, not vs-bots
    seat = i;
  }
  return seat;
}

/** Can this client move right now: in a local game, always (except during a
 *  bot's turn); in online, only on our own seat. */
export function myTurn(c: SeatCtx): boolean {
  if (c.game && isBotSeat(c.game, c.game.current)) return false;
  if (c.mySeat === null) return true;
  return c.game !== null && c.mySeat === c.game.current;
}

/**
 * The seat we show the candidate fan for and allow pre-picking on —
 * regardless of whose turn it currently is: online → our own seat; local
 * vs-bots → the one human. Requires the seat to be active (not in gravel,
 * not finished, not retired). −1 means pre-picking is unavailable (including
 * hotseat). On our own turn this matches game.current, so normal play
 * follows the same path.
 */
export function preselectSeat(c: SeatCtx): number {
  if (c.phase !== 'race' || !c.game || c.game.phase !== 'race') return -1;
  const seat = c.mySeat ?? soloHumanSeat(c.game);
  if (seat < 0) return -1;
  const p = c.game.players[seat];
  if (isFinished(p) || p.retired || p.skipTurns !== 0) return -1;
  return seat;
}

/**
 * The seat whose candidate fan we currently show/interact with: on our turn
 * it's whoever's moving (`game.current`) in any mode (hotseat/vs-bots/
 * online); on someone else's turn it's the pre-pick seat (`preselectSeat`,
 * online/vs-bots only). −1 means there are no candidates (someone else's
 * turn in hotseat, a penalty, or outside the race).
 */
export function candOwner(c: SeatCtx): number {
  if (!c.game || c.game.phase !== 'race') return -1;
  if (myTurn(c))
    return c.game.players[c.game.current].skipTurns === 0 ? c.game.current : -1;
  return preselectSeat(c);
}

/**
 * The local player's seat for the "Retire" button: in online it's our own
 * seat; locally it's the current mover if they're human (nobody to retire
 * during a bot's turn — the button is hidden). −1 if there's no race or a
 * bot is currently moving.
 */
export function localHumanSeat(c: SeatCtx): number {
  if (!c.game) return -1;
  if (c.mySeat !== null) return c.mySeat;
  return isBotSeat(c.game, c.game.current) ? -1 : c.game.current;
}

/** Whether the "Retire" button is currently available: the race is running
 *  and the local player is still in it (not finished, not retired). Retiring
 *  is allowed at any time, not just on our turn. */
export function canRetire(c: SeatCtx): boolean {
  if (!c.game || c.phase !== 'race' || c.game.phase !== 'race') return false;
  const seat = localHumanSeat(c);
  return seat >= 0 && !isFinished(c.game.players[seat]) && !c.game.players[seat].retired;
}
