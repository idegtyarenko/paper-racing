// Online bots (host-local fill) — lobby bot config (count/difficulty) and the host
// computing + committing their moves. Split out of online-controller.ts (which had
// become a god-module): two self-contained subsystems (bots and turn watching) moved
// into their own modules, leaving the controller a thin facade.
//
// The host keeps the bot count and difficulty locally; on start they materialize into
// the remaining free seats (buildStartState) and travel to guests inside the state
// (Player.bot). Guests don't drive bots — only the host computes and commits bot
// moves (see scheduleBotMove). Live players take priority: bots don't occupy server
// lobby seats, so an incoming player is never blocked by a bot, and lobbyBots is
// clamped down to whatever seats remain free.
//
// Doesn't own app state: reads/mutates it through the OnlineDeps passed to init, and
// does confirm-first/redraws/clearing turn watch via the callbacks it's given (the
// confirm-first core and commitOnline live in the controller, clearTurnWatch in turn-watch).

import { Track } from '../model/track';
import { GameState, newGame, shuffledIndices, seatColor } from '../model/game';
import { coastMove, applyMove } from '../model/turns';
import { Difficulty, chooseMove } from '../model/ai';
import { renderLobby } from '../ui/lobby';
import { showToast } from '../ui/dialogs';
import { strings } from '../i18n';
import { AI_MOVE_DELAY_MS, SKIP_RETRY_MS } from '../config';
import * as session from './online';
import type { OnlineDeps } from './online-controller';

/** Result of confirm-first (see the controller): either we applied our copy
 *  (`applied`), or an authoritative state arrived while writing and local application was skipped. */
type PushResult = 'applied' | 'superseded';
type ConfirmFirst = (
  base: GameState,
  mutate: (next: GameState) => void,
) => Promise<PushResult>;

/**
 * host-bots's dependencies: the shared app state by reference (deps) plus
 * behavioral callbacks from the controller/turn-watch. `confirmFirst` is the shared
 * confirm-first core (clone→mutate→push→identity guard→setGame); `commitOnline` is
 * the online redraw; `clearTurnWatch` clears turn watching (which also stops our
 * botTimer) before the panel redraws after a bot move.
 */
export interface HostBotsDeps {
  deps: OnlineDeps;
  confirmFirst: ConfirmFirst;
  commitOnline(): void;
  clearTurnWatch(): void;
}

let deps: OnlineDeps;
let confirmFirst: ConfirmFirst;
let commitOnline: () => void;
let clearTurnWatch: () => void;

export function initHostBots(h: HostBotsDeps): void {
  deps = h.deps;
  confirmFirst = h.confirmFirst;
  commitOnline = h.commitOnline;
  clearTurnWatch = h.clearTurnWatch;
}

// ── Lobby bot config (host-local) ────────────────────────────────────────────────
let lobbyBots = 0;
let lobbyBotDifficulty: Difficulty = 'medium';
/** Timer for a delayed bot move (host-only) — cleared together with turn watching. */
let botTimer: number | null = null;
/** Whether a bot move write is in flight (host-only) — guards against duplicates, like skipSending. */
let botSending = false;

/** Clear added bots (a fresh host lobby starts with none). Difficulty setting is kept. */
export function resetBots(): void {
  lobbyBots = 0;
}

/** Clear the delayed bot-move timer (called from turn-watch.clearTurnWatch). */
export function clearBotTimer(): void {
  if (botTimer !== null) {
    clearTimeout(botTimer);
    botTimer = null;
  }
}

/** Free lobby seats available for bots: track capacity minus real players. */
function freeSeats(): number {
  const cap = deps.state.raceTrack?.startPoints.length ?? 0;
  return Math.max(0, cap - session.getRoster().length);
}

/** Is this seat occupied by a bot (in a running race)? Bot-ness lives in the state (Player.bot). */
export function isBotSeat(game: GameState, seat: number): boolean {
  return !!game.players[seat]?.bot;
}

/**
 * Schedule a bot move (host-only): wait AI_MOVE_DELAY_MS so a human has a chance to
 * follow the bot's move, same as in local play. Only one timer at a time
 * (clearTurnWatch cancels it on every re-arm of turn watching).
 */
export function scheduleBotMove(seat: number): void {
  if (botTimer !== null) return;
  botTimer = window.setTimeout(() => {
    botTimer = null;
    runBotMove(seat);
  }, AI_MOVE_DELAY_MS);
}

/**
 * Compute and commit a bot's move (host-only, confirm-first): apply the bot's move to
 * a copy of the state, write it to the server, and only on success make it current —
 * guests receive it like any other player's move (echo guard, same as in applySkip).
 * No move/no nav → coast instead. On error, silently retry after SKIP_RETRY_MS.
 * botSending guards against a parallel write while one is already waiting on the server.
 */
async function runBotMove(seat: number): Promise<void> {
  if (botSending) return;
  const game = deps.state.game;
  if (
    !game ||
    game.phase !== 'race' ||
    game.current !== seat ||
    !isBotSeat(game, seat) ||
    !session.isHost()
  )
    return;
  botSending = true;
  const nav = deps.state.raceNav;
  try {
    const r = await confirmFirst(game, (next) => {
      // No move/no nav → coast instead. `cand` is computed on the copy inside mutate.
      const cand = nav ? chooseMove(next, nav, game.players[seat].bot!) : null;
      if (cand) applyMove(next, cand);
      else coastMove(next);
    });
    if (r === 'applied') {
      clearTurnWatch(); // reset skipVisible/countdown before the panel redraws
      commitOnline();
    }
  } catch {
    showToast(strings.online.error);
    // Silent retry: it's still the bot's turn and we're still host — runBotMove will re-check.
    botTimer = window.setTimeout(() => {
      botTimer = null;
      runBotMove(seat);
    }, SKIP_RETRY_MS);
  } finally {
    botSending = false;
  }
}

/** Redraw the lobby panel from the session's current roster. */
export function renderLobbyPanel(): void {
  const roster = session.getRoster();
  const mine = session.mySeat();
  const maxBots = freeSeats();
  // Live players take priority over bots: if a new player joined, there are fewer
  // free seats — shrink the bot count to fit (if a player leaves, the max grows back,
  // but we don't restore the previous bot count — only the upper bound).
  if (lobbyBots > maxBots) lobbyBots = maxBots;
  renderLobby({
    code: session.getCode() ?? '',
    players: roster.map((r, i) => ({
      name: r.name,
      color: seatColor(i),
      you: i === mine,
      offline: !session.isPresent(i),
    })),
    canStart: session.canStart(),
    isHost: session.isHost(),
    botCount: lobbyBots,
    maxBots,
    botDifficulty: lobbyBotDifficulty,
  });
}

/** Host: add another bot to a free lobby seat (up to capacity). */
export function addBot(): void {
  if (!session.isHost() || lobbyBots >= freeSeats()) return;
  lobbyBots++;
  renderLobbyPanel();
}

/** Host: remove one bot. */
export function removeBot(): void {
  if (!session.isHost() || lobbyBots <= 0) return;
  lobbyBots--;
  renderLobbyPanel();
}

/** Host: change the difficulty of newly added bots. */
export function setBotDifficulty(diff: Difficulty): void {
  if (!session.isHost()) return;
  lobbyBotDifficulty = diff;
  renderLobbyPanel();
}

/**
 * Build the starting state for an online race from the current roster and the
 * host-local bot config. Shared by starting from the lobby (startOnline) and a
 * rematch (rematchOnline) — the lineup is the same (same humans + same bots), only
 * the random assignment of start cells changes. Start cells are assigned via a random
 * permutation across all participants. Only the host does this, and the result travels
 * in the serialized state (guests don't recompute `players`), so clients don't need a shared seed.
 */
export function buildStartState(raceTrack: Track): GameState {
  const roster = session.getRoster();
  const humans = roster.length;
  const bots = Math.min(lobbyBots, freeSeats());
  const g = newGame(
    raceTrack,
    humans + bots,
    deps.state.rules,
    shuffledIndices(humans + bots),
  );
  roster.forEach((r, i) => {
    if (g.players[i]) g.players[i].name = r.name;
  });
  // Add bots into the remaining free seats (after the real players): their
  // bot-ness travels in the state (Player.bot), guests get them through the regular
  // sync, and only the host computes their moves (scheduleBotMove).
  for (let i = humans; i < g.players.length; i++) {
    g.players[i].bot = lobbyBotDifficulty;
    g.players[i].name = `${strings.aiSelect.botPrefix} ${g.players[i].name}`;
  }
  return g;
}
