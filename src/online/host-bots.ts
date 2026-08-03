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
import { GameState, newGame, shuffledIndices, seatColor, seatName } from '../model/game';
import { coastMove, applyMove } from '../model/turns';
import { Difficulty, chooseMove } from '../model/ai';
import type { LobbyView } from '../ui/pr-chrome';
import { showErrorToast } from '../ui/dialogs';
import { strings } from '../i18n';
import { SKIP_RETRY_MS } from '../config';
import { botMoveDelayMs } from '../bot-pacing';
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
/** How many bots have already moved in the current unbroken run — the pause shrinks with
 *  each one. Not cleared by clearBotTimer: that fires on every re-arm of turn watching,
 *  including between two bot moves. Only a human's turn ends the run. */
let botStreak = 0;
/** Turn number the streak was last counted for — a presence event re-arms turn watching
 *  mid-pause, and rescheduling the *same* turn must not count as another bot in the run. */
let botStreakTurn = -1;

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

/** Seats on the starting grid of the race's track — the roster's capacity. Read
 *  from the session (the guest doesn't own the track, but has a copy of it). */
function seatCapacity(): number {
  return session.getTrack()?.startPoints.length ?? 0;
}

/** Free lobby seats available for bots: track capacity minus real players. Someone who
 *  left a race gives their seat back — the next race is built without them. */
function freeSeats(): number {
  return Math.max(0, seatCapacity() - session.activeRoster().length);
}

/** Is this seat occupied by a bot (in a running race)? Bot-ness lives in the state (Player.bot). */
export function isBotSeat(game: GameState, seat: number): boolean {
  return !!game.players[seat]?.bot;
}

/** The bot run is over — the next bot waits the full pause again. Called from
 *  turn-watch when the turn belongs to a human. */
export function resetBotStreak(): void {
  botStreak = 0;
  botStreakTurn = -1;
}

/**
 * Schedule a bot move (host-only): wait a beat so a human has a chance to follow
 * the bot's move, same as in local play — and, same as there, shrink that pause with
 * every next bot in an unbroken run (botMoveDelayMs). Only one timer at a time
 * (clearTurnWatch cancels it on every re-arm of turn watching).
 */
export function scheduleBotMove(seat: number): void {
  if (botTimer !== null) return;
  const turn = deps.state.game?.turn ?? -1;
  if (turn !== botStreakTurn) {
    botStreakTurn = turn;
    botStreak += 1;
  }
  botTimer = window.setTimeout(
    () => {
      botTimer = null;
      runBotMove(seat);
    },
    botMoveDelayMs(botStreak - 1),
  );
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
    showErrorToast(strings.online.error);
    // Silent retry: it's still the bot's turn and we're still host — runBotMove will re-check.
    botTimer = window.setTimeout(() => {
      botTimer = null;
      runBotMove(seat);
    }, SKIP_RETRY_MS);
  } finally {
    botSending = false;
  }
}

/** Whether the host's "start the race" write is in flight (the button is held
 *  disabled meanwhile). Lives here so it survives the presence-driven re-renders
 *  that happen during the await. */
let starting = false;

export function setLobbyStarting(b: boolean): void {
  starting = b;
}

/**
 * Everything the lobby screens draw, assembled from the session in one place —
 * the host's variant of the setup screen and the guest's own screen render the
 * same view. Null outside a live lobby.
 */
export function lobbyView(): LobbyView | null {
  if (!session.active()) return null;
  const roster = session.getRoster();
  const mine = session.mySeat();
  const maxBots = freeSeats();
  // Live players take priority over bots: if a new player joined, there are fewer
  // free seats — shrink the bot count to fit (if a player leaves, the max grows back,
  // but we don't restore the previous bot count — only the upper bound).
  if (lobbyBots > maxBots) lobbyBots = maxBots;
  return {
    code: session.getCode() ?? '',
    players: roster.map((r, i) => ({
      // Anyone who hasn't typed a name yet reads as their car's colour — the
      // name they'd race under. Your own row is the field, so it stays empty.
      name: r.name || (i === mine ? '' : seatName(i)),
      color: seatColor(i),
      you: i === mine,
      host: r.clientId === session.hostId(),
      offline: !session.isPresent(i),
    })),
    seats: seatCapacity(),
    isHost: session.isHost(),
    canStart: session.canStart(),
    needsName: mine >= 0 && !roster[mine]?.name,
    botCount: lobbyBots,
    maxBots,
    botDifficulty: lobbyBotDifficulty,
    connected: session.isConnected(),
    starting,
  };
}

/** Host: how many bots fill the free seats (the lobby offers an absolute count). */
export function setBotCount(n: number): void {
  if (!session.isHost()) return;
  lobbyBots = Math.max(0, Math.min(n, freeSeats()));
  deps.updateUI();
}

/** Host: change the difficulty of newly added bots. */
export function setBotDifficulty(diff: Difficulty): void {
  if (!session.isHost()) return;
  lobbyBotDifficulty = diff;
  deps.updateUI();
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
  // Whoever left a race in progress keeps their (flagged) roster entry so the running
  // race's seats stay put — but they don't get a car in the next one, so the lineup is
  // built from the active entries, and the seats close up behind them.
  const roster = session.activeRoster();
  const humans = roster.length;
  const bots = Math.min(lobbyBots, freeSeats());
  const g = newGame(
    raceTrack,
    humans + bots,
    deps.state.rules,
    shuffledIndices(humans + bots),
  );
  roster.forEach((r, i) => {
    // A racer who never typed a name keeps the one newGame gave the seat — their
    // car's colour. The host can start without waiting on anyone's typing.
    if (g.players[i] && r.name) g.players[i].name = r.name;
  });
  // Add bots into the remaining free seats (after the real players): their
  // bot-ness travels in the state (Player.bot), guests get them through the regular
  // sync, and only the host computes their moves (scheduleBotMove).
  for (let i = humans; i < g.players.length; i++) {
    g.players[i].bot = lobbyBotDifficulty;
  }
  return g;
}
