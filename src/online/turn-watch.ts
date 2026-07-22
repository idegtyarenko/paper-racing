// Turn watcher: timeout + skip (coasting) + countdown display, plus pruning
// abandoned lobby seats. Split out of online-controller.ts (which had become a god-module).
//
// A present but stalling player can be skipped by any other player once the turn
// limit expires (manual button). An absent player (closed the tab) gets skipped
// automatically: the first skip gets a grace period from the moment they left (a
// chance to reconnect), after that it's immediate. Auto-skip is only performed by the
// "designated" present client (lowest seat number), so we don't send duplicates; the
// result is deterministic, so there's no write race.
//
// Doesn't own app state: reads/mutates it through the OnlineDeps passed to init, and
// does confirm-first/redraws via the callbacks it's given. Bot moves are delegated to
// host-bots (bot seats never tick a timer and are never skipped for being slow).

import { GameState, isFinished } from '../model/game';
import { coastMove } from '../model/turns';
import { showToast } from '../ui/dialogs';
import type { NetTurn } from '../ui/panel';
import { strings } from '../i18n';
import { TURN_TIMEOUT_MS, LOBBY_PRUNE_MS, SKIP_RETRY_MS } from '../config';
import * as session from './online';
import { isBotSeat, scheduleBotMove, clearBotTimer } from './host-bots';
import type { OnlineDeps } from './online-controller';

/** Result of confirm-first (see the controller): either we applied our copy
 *  (`applied`), or an authoritative state arrived while writing and local application was skipped. */
type PushResult = 'applied' | 'superseded';
type ConfirmFirst = (
  base: GameState,
  mutate: (next: GameState) => void,
) => Promise<PushResult>;

/**
 * turn-watch's dependencies: the shared app state by reference (deps) plus
 * behavioral callbacks. `confirmFirst` is the shared confirm-first core; `commitOnline`
 * is the online redraw (owned by the controller, since it finishes by re-arming armTurnWatch here).
 */
export interface TurnWatchDeps {
  deps: OnlineDeps;
  confirmFirst: ConfirmFirst;
  commitOnline(): void;
}

let deps: OnlineDeps;
let confirmFirst: ConfirmFirst;
let commitOnline: () => void;

export function initTurnWatch(h: TurnWatchDeps): void {
  deps = h.deps;
  confirmFirst = h.confirmFirst;
  commitOnline = h.commitOnline;
}

let skipTimer: number | null = null;
let lobbyPruneTimer: number | null = null;
/** Turn time-remaining tracker: the moment the turn started (local clock) plus a
 *  ticker that refreshes the display. This is a local, per-client count (no shared
 *  timestamp in the state) — small drift between clients is fine for a "soft" timer. */
let turnStartAt: number | null = null;
let tickTimer: number | null = null;
/** Whether to show the manual skip button (true only for a player who's present). */
let skipVisible = false;
/** Whether a skip (auto or manual) write is in flight — guards against duplicates. */
let skipSending = false;

export function clearTurnWatch(): void {
  if (skipTimer !== null) {
    clearTimeout(skipTimer);
    skipTimer = null;
  }
  clearBotTimer(); // bot moves get cleared along with turn watching (host-bots owns that timer)
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  turnStartAt = null;
  deps.setTurnCountdown(null, false); // clear the timer display — otherwise it'd freeze at "· 0:00"
  skipVisible = false;
}

/** Clear all watch timers (leaving the session / game closed). */
export function clearWatches(): void {
  clearTurnWatch();
  if (lobbyPruneTimer !== null) {
    clearTimeout(lobbyPruneTimer);
    lobbyPruneTimer = null;
  }
}

/**
 * Remove lobby seats whose tabs have been offline longer than LOBBY_PRUNE_MS (a grace
 * period for reconnecting). Only the designated present client prunes. If any seat's
 * grace period hasn't expired yet, reschedule the check for the nearest deadline
 * (without waiting for a new presence event).
 */
export function pruneAbsentLobby(): void {
  if (lobbyPruneTimer !== null) {
    clearTimeout(lobbyPruneTimer);
    lobbyPruneTimer = null;
  }
  if (session.designatedSkipper() !== session.mySeat()) return;
  let soonest = Infinity;
  session.getRoster().forEach((_, seat) => {
    const left = session.leftAtOf(seat);
    if (left === null) return;
    const waited = Date.now() - left;
    if (waited >= LOBBY_PRUNE_MS) session.prune(seat).catch(() => {});
    else soonest = Math.min(soonest, LOBBY_PRUNE_MS - waited);
  });
  if (soonest !== Infinity) {
    lobbyPruneTimer = window.setTimeout(() => {
      if (deps.state.phase === 'lobby') pruneAbsentLobby();
    }, soonest);
  }
}

/**
 * Whether the local player is active in this state: still in the race — hasn't
 * retired and hasn't finished. Only such players are allowed to skip other players' turns.
 */
function iAmActive(game: GameState): boolean {
  const me = game.players[session.mySeat()];
  return !!me && !isFinished(me) && !me.retired;
}

/** Recompute turn watching for the current turn. Called on every state change and presence event. */
export function armTurnWatch(): void {
  clearTurnWatch();
  const game = deps.state.game;
  // Mode gate (same idea as scheduleAiMove): a presence event in the lobby calls
  // armTurnWatch, but a previous race might still be sitting in state.game with phase
  // 'race' (creating a new lobby doesn't clear it) — without this check we'd show a
  // turn-timer button for someone else's/our own turn while in the lobby.
  if (!session.active() || !game || game.phase !== 'race' || deps.state.phase !== 'race')
    return;
  const cur = game.current;

  // Only the host computes and commits bot moves; guests just wait for its pushMove
  // like any other player's move. A bot seat is never "present" (otherwise
  // designatedSkipper would auto-skip it) and never ticks a timer — bots aren't time-limited.
  if (isBotSeat(game, cur)) {
    if (session.isHost()) scheduleBotMove(cur);
    return;
  }

  // Turn limit comes from the race rules (set by the host in settings); old states
  // without the field fall back to a default.
  const limit = game.rules.turnLimitMs ?? TURN_TIMEOUT_MS;

  // Local countdown of time remaining — for me (label on the button) and for
  // opponents (suffix in the status). Start it before the "my turn" early return, so it's visible to me too.
  turnStartAt = Date.now();
  const tick = (): void => {
    const g = deps.state.game;
    if (!session.active() || !g || g.phase !== 'race' || turnStartAt === null) return;
    const msLeft = Math.max(0, limit - (Date.now() - turnStartAt));
    deps.setTurnCountdown(msLeft, g.current === session.mySeat());
  };
  tick();
  tickTimer = window.setInterval(tick, 500);

  if (cur === session.mySeat()) return; // my turn — I don't watch myself (no skip needed)

  if (session.isPresent(cur)) {
    // Online but taking their time — once the limit expires, open manual skip to
    // everyone else. Only an active player (not retired, not finished) may skip
    // someone else's turn — players out of the race no longer participate.
    if (!iAmActive(game)) return;
    skipTimer = window.setTimeout(() => {
      skipVisible = true;
      deps.updateUI();
    }, limit);
    return;
  }
  // Absent: auto-skip is performed by the designated present client.
  if (session.designatedSkipper() !== session.mySeat()) return;
  const left = session.leftAtOf(cur);
  const grace = left === null ? limit : Math.max(0, limit - (Date.now() - left));
  skipTimer = window.setTimeout(() => autoSkip(cur), grace);
}

/** Auto-skip an absent player (if they're still offline and it's still their turn). */
function autoSkip(seat: number): void {
  const game = deps.state.game;
  if (!game || game.phase !== 'race' || game.current !== seat) return;
  if (session.isPresent(seat)) return; // they're back — wait for them to move themselves
  if (session.designatedSkipper() !== session.mySeat()) return;
  applySkip(game);
}

/**
 * Apply a skip (confirm-first): the car coasts in a copy of the state, we write it to
 * the server, and only on success make it the current state. On error, nothing
 * changes locally. Auto-skip: silently reschedule a retry after SKIP_RETRY_MS
 * (autoSkip will re-check the conditions itself); manual skip: leave the button in
 * place so it can be clicked again.
 */
async function applySkip(game: GameState): Promise<void> {
  if (skipSending) return;
  skipSending = true;
  try {
    const r = await confirmFirst(game, (next) => coastMove(next));
    if (r === 'applied') {
      clearTurnWatch(); // reset skipVisible/countdown before the panel redraws
      commitOnline();
    }
  } catch {
    showToast(strings.online.error);
    // Auto-skip: retry silently — autoSkip will re-check (same turn, player still
    // offline, I'm still designated). Manual skip: skipVisible stays true, button is available again.
    if (!session.isPresent(game.current)) {
      skipTimer = window.setTimeout(() => autoSkip(game.current), SKIP_RETRY_MS);
    }
  } finally {
    skipSending = false;
  }
}

/** Online context for the current turn, for the panel: whose turn it is, whether it's
 *  mine, whether it can be skipped, who's currently offline. Null if not in an online game. */
export function netTurn(game: GameState | null): NetTurn | null {
  if (!session.active() || !game) return null;
  return {
    yourTurn: session.mySeat() === game.current,
    canSkip: skipVisible,
    currentName: game.players[game.current]?.name ?? '',
    // Bot seats are always "online" (the host drives them) — never mark them offline.
    present: game.players.map((p, i) => !!p.bot || session.isPresent(i)),
    code: session.getCode() ?? '',
    isHost: session.isHost(),
  };
}

/** "Skip turn" button (available once a present player's timeout has expired). */
export function skip(): void {
  const game = deps.state.game;
  if (!game || game.phase !== 'race' || !skipVisible) return;
  if (game.current === session.mySeat()) return;
  if (!iAmActive(game)) return; // a retired player can't skip someone else's turn
  applySkip(game);
}
