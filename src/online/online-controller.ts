// Online flow layered on top of online.ts: host/join/start/leave/share plus the
// session's realtime event handlers. All the "network meets UI" glue lives here,
// out of main.ts. The controller doesn't own app state (game/mode/raceTrack/editor) —
// it reads and mutates it through the OnlineDeps passed to init, and does its
// redraws/recalculations via that same object's callbacks. Exactly one controller
// per app.
//
// Two self-contained subsystems have been split out into sibling modules (this used
// to be a god-module):
//   • turn-watch.ts — turn watching, countdown, manual/auto-skip, lobby pruning;
//   • host-bots.ts — lobby bot config plus the host computing and committing bot moves.
// The controller hands them the shared state (deps) and confirmFirst/commitOnline via init.

import { GameState, Candidate, cloneState, isFinished } from '../model/game';
import { applyMove, retireSeat } from '../model/turns';
import { editorFromTrack } from '../model/editor';
import { setLobbyStarting } from '../ui/lobby';
import {
  openNameDialog,
  openJoinDialog,
  showJoinError,
  showToast,
  setJoinBusy,
  setConnBanner,
} from '../ui/dialogs';
import { closeOverlay } from '../ui/dom';
import { openConfirm } from '../ui/confirm';
import { AppState } from '../app-state';
import { setMoveSendState } from '../ui/panel';
import { strings } from '../i18n';
import * as session from './online';
import { OnlineHandlers } from './online';
import * as hostBots from './host-bots';
import * as turnWatch from './turn-watch';

/**
 * Bridge to the main module: the controller doesn't hold state itself. It reads
 * and mutates data by reference through `state` (`state.game`, `state.phase`, …),
 * so we don't need a separate get/set shim for every field. What's left are
 * behavioral callbacks: `setGame` (which has side effects — stops the bot loop,
 * rebuilds nav) and redraw/reset/timer.
 */
export interface OnlineDeps {
  /** Single shared app state (by reference, see app-state.ts). */
  state: AppState;
  /** Swap in a new game: stops the local bot loop, rebuilds nav, clears rematch state. */
  setGame(g: GameState): void;
  /** Fit the current content (track) centered in the viewport. */
  fitToContent(): void;
  refreshCands(): void;
  updateUI(): void;
  /** Show time left on the current turn (mine goes on the button, others' in the status). */
  setTurnCountdown(msLeft: number | null, mine: boolean): void;
  redraw(): void;
  /** Full reset back to a clean editor (leaving online mode). */
  resetToEdit(): void;
}

let deps: OnlineDeps;

export function initOnline(d: OnlineDeps): void {
  deps = d;
  // Hand the sub-modules the shared state and confirmFirst/commitOnline. host-bots
  // additionally gets clearTurnWatch (to clear turn watching before redrawing after a bot move).
  hostBots.initHostBots({
    deps: d,
    confirmFirst,
    commitOnline,
    clearTurnWatch: turnWatch.clearTurnWatch,
  });
  turnWatch.initTurnWatch({ deps: d, confirmFirst, commitOnline });
  // On page close/navigate-away: drop presence immediately (so others notice we're
  // offline sooner and start skipping us), and if we're actually unloading from the
  // lobby, free our seat. During a race we keep the seat — auto-skip handles that.
  // persisted → bfcache (the page may come back), so we don't tear down the session.
  window.addEventListener('pagehide', (e: PageTransitionEvent) => {
    if (!session.active()) return;
    session.untrack();
    if (!e.persisted && deps.state.phase === 'lobby') {
      session.leave();
      forgetSession(); // seat is freed — nothing to come back to
    }
  });
}

// ── Duplicate-call guarding and confirm-first sending ─────────────────────────────

/** Whether a session operation (host/join/start/leave) is in flight — at most one at
 *  a time, so repeated taps don't spawn parallel create/join attempts. */
let busy = false;
async function guarded(fn: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } finally {
    busy = false;
  }
}

/** Whether a move is currently being sent, and which candidate is pending (for retry after an error). */
let sending = false;
let pendingCand: Candidate | null = null;

/** Result of a confirm-first push: either we applied our copy locally (`applied`), or
 *  an authoritative state arrived from elsewhere while writing and we skipped applying ours (`superseded`). */
type PushResult = 'applied' | 'superseded';

/**
 * Shared core of every "confirm-first" operation (move/retire/skip/bot move): apply
 * `mutate` to a COPY of `base`, write it to the server, and only on success — and only
 * if no authoritative state arrived from elsewhere while writing — make the copy the
 * current state. The original is never touched, so on error the player's selection and
 * candidates stay intact. Write errors are RETHROWN: each caller has its own error
 * handling (flags, toast, retry). The caller is responsible for redrawing
 * (commitOnline) and clearing flags based on the result, which preserves exact
 * ordering (clear send-state before redraw; clearTurnWatch before redraw on
 * skip/bot moves). Shared with turn-watch/host-bots via init (applySkip/runBotMove use it too).
 */
async function confirmFirst(
  base: GameState,
  mutate: (next: GameState) => void,
): Promise<PushResult> {
  const next = cloneState(base);
  mutate(next);
  await session.pushMove(next);
  if (deps.state.game !== base) return 'superseded'; // an echo or someone else's move already applied
  deps.setGame(next);
  return 'applied';
}

/**
 * Online counterpart to the local commit(): recompute candidates → panel → canvas →
 * re-arm turn watching (armTurnWatch). Call this after setGame has made our own or an
 * incoming state current. Differs from main.commit in that it finishes with
 * armTurnWatch instead of scheduleAiMove (online-specific: turn timer, auto-skip, host
 * running bot moves). onGameState doesn't use this — it needs a special order there
 * (armTurnWatch before updateUI, so skipVisible resets for the new turn). Shared with turn-watch/host-bots.
 */
function commitOnline(): void {
  deps.refreshCands();
  deps.updateUI();
  deps.redraw();
  turnWatch.armTurnWatch();
}

/**
 * Send our move (confirm-first): apply it to a copy, write it to the server, and only
 * on success make the copy the current state. The original is left untouched, so on
 * error the player's selection and candidates stay intact and the button turns into
 * "↻ Retry sending". Identity guard: if an authoritative state (echo or someone else's
 * move) arrives while the write is in flight, we skip applying ours locally.
 */
export async function sendMove(cand: Candidate): Promise<void> {
  const game = deps.state.game;
  if (!game || game.phase !== 'race' || sending) return;
  if (session.mySeat() !== game.current) return; // no longer our turn
  sending = true;
  pendingCand = cand;
  setMoveSendState('sending');
  try {
    const r = await confirmFirst(game, (next) => applyMove(next, cand));
    sending = false;
    pendingCand = null;
    setMoveSendState('idle');
    if (r === 'applied') commitOnline();
  } catch {
    sending = false;
    if (deps.state.game !== game) {
      pendingCand = null;
      setMoveSendState('idle');
      return;
    }
    setMoveSendState('failed');
    deps.updateUI(); // status → "failed to send…"
  }
}

/** Retry the last failed move send (desktop: there's no selection, so we use pendingCand). */
export function retryMove(): void {
  if (pendingCand) sendMove(pendingCand);
}

/**
 * Retire (confirm-first): the player drops out of the race. Apply retireSeat for our
 * own seat to a copy, write it to the server, and only on success make it the current
 * state. Retiring can happen at any time, not just on our turn (retireSeat doesn't
 * advance the queue if the retiring seat isn't the one currently moving). On error,
 * show a toast and reset state (no retry: retiring isn't critical, the player can just
 * click again).
 */
export async function sendRetire(): Promise<void> {
  const game = deps.state.game;
  if (!game || game.phase !== 'race' || sending) return;
  const seat = session.mySeat();
  const me = game.players[seat];
  if (!me || isFinished(me) || me.retired) return; // already finished/retired
  sending = true;
  setMoveSendState('sending');
  try {
    const r = await confirmFirst(game, (next) => retireSeat(next, seat));
    sending = false;
    setMoveSendState('idle');
    if (r === 'applied') commitOnline();
  } catch {
    sending = false;
    setMoveSendState('idle');
    showToast(strings.online.error);
  }
}

function savedName(): string {
  try {
    return localStorage.getItem('pr-player-name') ?? '';
  } catch {
    // localStorage unavailable (private browsing) — there's just no saved name.
    return '';
  }
}
function rememberName(n: string): void {
  try {
    localStorage.setItem('pr-player-name', n);
  } catch {
    // unavailable — don't save it, no big deal.
  }
}

// ── "Breadcrumb" of the last online session ─────────────────────────────────────
// The active game's code, kept in localStorage: after a disconnect/reload (when the
// in-memory code in online.ts is gone) this lets us offer to resume the game on startup.
const SESSION_KEY = 'pr-online-session';
function rememberSession(code: string): void {
  try {
    // Called on every applyRow (including every move) — skip the write if it's already current.
    if (localStorage.getItem(SESSION_KEY) !== code)
      localStorage.setItem(SESSION_KEY, code);
  } catch {
    // localStorage unavailable — just don't save it.
  }
}
function savedSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}
function forgetSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // unavailable — no big deal.
  }
}

/** Turn a join error into user-facing text. */
function joinErrorText(e: unknown): string {
  const m = (e as { message?: string })?.message ?? '';
  if (m.includes('game_not_found')) return strings.online.notFound;
  if (m.includes('game_full')) return strings.online.full;
  if (m.includes('game_started')) return strings.online.started;
  return strings.online.error;
}

const handlers: OnlineHandlers = {
  onLobby: () => {
    // We're in a live lobby — remember the code for resuming after a disconnect (idempotent).
    rememberSession(session.getCode()!);
    if (deps.state.phase === 'lobby') hostBots.renderLobbyPanel();
  },
  onGameState: (g) => {
    // An incoming authoritative state overrides our own unfinished/failed move: clear
    // the pending state (a late resolve of our own send becomes a no-op thanks to the
    // identity guard in sendMove, and the DB applies last-write-wins anyway).
    pendingCand = null;
    setMoveSendState('idle');
    // Resume breadcrumb: keep it while the race is ongoing, clear it once the race is
    // over (no point resuming to the winner screen). This is the single place that
    // owns "remember/forget" based on authoritative state — called on every applyRow.
    if (g.phase === 'over') forgetSession();
    else rememberSession(session.getCode()!);
    // Rematch: a fresh race arrived on top of the results screen. The host never left
    // race mode, so the normal transition below (mode !== 'race') won't fire — catch
    // over→race separately to close the winner dialog/banner and re-fit the field.
    const wasOver = deps.state.game?.phase === 'over';
    deps.setGame(g);
    if (deps.state.phase !== 'race') {
      deps.state.phase = 'race';
      closeOverlay();
      deps.fitToContent();
    } else if (wasOver && g.phase === 'race') {
      closeOverlay();
      deps.fitToContent();
    }
    deps.refreshCands();
    // armTurnWatch before updateUI: it resets skipVisible for the new turn, otherwise a
    // stale skip flag from the previous turn would leak into the render (a "hasn't
    // moved in a while" button showing on our own turn).
    turnWatch.armTurnWatch();
    deps.updateUI();
    deps.redraw();
  },
  onClosed: () => {
    turnWatch.clearWatches();
    forgetSession(); // the game was deleted/closed by the host — nothing to come back to
    pendingCand = null;
    setMoveSendState('idle');
    setConnBanner(false);
    setLobbyStarting(false);
    showToast(strings.online.closed);
    deps.resetToEdit();
  },
  onConnection: (ok) => {
    setConnBanner(!ok);
    deps.updateUI();
  },
  onPresence: () => {
    // Presence affects "wait or skip" decisions and the offline markers in the
    // panel/lobby; in the lobby it also prunes abandoned seats.
    turnWatch.armTurnWatch();
    if (deps.state.phase === 'lobby') {
      turnWatch.pruneAbsentLobby();
      hostBots.renderLobbyPanel();
    }
    deps.updateUI();
  },
};

/** Create an online game (as host) with the entered name and open the lobby. */
function hostOnline(name: string): Promise<void> {
  return guarded(async () => {
    const raceTrack = deps.state.raceTrack;
    if (!raceTrack) return;
    hostBots.resetBots(); // fresh lobby — no leftover bots from before
    try {
      await session.host(raceTrack, name, handlers);
      deps.state.phase = 'lobby';
      deps.updateUI();
      hostBots.renderLobbyPanel();
      deps.redraw();
    } catch {
      showToast(strings.online.error);
    }
  });
}

/**
 * Join an online game by code. When inJoinDialog is true, show the error right inside
 * the join dialog (which stays open); otherwise (joining via a broken invite link) we
 * open the join dialog pre-filled with the code and a persistent error message, so it's
 * clear what went wrong and the player can immediately try another code — instead of a
 * toast that faded after a couple seconds and left them stranded in the editor with no explanation.
 */
function joinOnline(code: string, name: string, inJoinDialog: boolean): Promise<void> {
  return guarded(async () => {
    if (inJoinDialog) setJoinBusy(true);
    try {
      await session.join(code, name, handlers);
      closeOverlay();
      const t = session.getTrack();
      if (t) {
        deps.state.editor = editorFromTrack(t); // preview of the host's track in the lobby
        deps.state.raceTrack = null; // the guest doesn't own the track
      }
      // Reconnecting into an already-running race: onGameState already switched us
      // into race mode — don't force it back to lobby. Otherwise (game not yet started) go to the lobby.
      if (deps.state.phase !== 'race') deps.state.phase = 'lobby';
      deps.fitToContent(); // center the host's track
      deps.redraw();
      deps.updateUI();
      if (deps.state.phase === 'lobby') hostBots.renderLobbyPanel();
    } catch (e) {
      if (inJoinDialog) {
        showJoinError(joinErrorText(e));
      } else {
        openJoinDialog(name, code, (code2, name2) => {
          rememberName(name2);
          joinOnline(code2, name2, true);
        });
        showJoinError(joinErrorText(e));
      }
    } finally {
      if (inJoinDialog) setJoinBusy(false);
    }
  });
}

/**
 * Host starts the online race (confirm-first): builds the state, writes it to the
 * server first, and only on success enters the race. On error we stay in the lobby —
 * "Start game" becomes active again, and guests never saw anything (nothing was written).
 */
function startOnline(): Promise<void> {
  return guarded(async () => {
    const raceTrack = deps.state.raceTrack;
    if (!raceTrack || !session.canStart()) return;
    const g = hostBots.buildStartState(raceTrack);
    setLobbyStarting(true);
    try {
      await session.start(g);
      if (deps.state.phase !== 'race') {
        // An echo of our own write may have already switched us into the race — don't duplicate it.
        deps.setGame(g);
        deps.state.phase = 'race';
        deps.fitToContent();
        commitOnline();
      }
    } catch {
      showToast(strings.online.startFailed);
    } finally {
      setLobbyStarting(false);
    }
  });
}

/** Whether this client can start a rematch: it's the host and the race is over — in
 *  that case one tap replays the same track with the same lineup ("🔄 Rematch" button on the results screen). */
export function canRematch(): boolean {
  const game = deps.state.game;
  return session.isHost() && !!game && game.phase === 'over';
}

/**
 * Host starts a rematch on the same track with the same lineup (after an online
 * race). We reuse the same room: build a fresh state from the current roster plus
 * host-local bots and write it into the existing game row (status over→race). All
 * clients still subscribed to the channel receive it through the regular onGameState
 * and drop straight into the new race — no new code, no re-joining the lobby. On
 * error we stay on the results screen (nothing was written, so guests saw nothing).
 */
function rematchOnline(): Promise<void> {
  return guarded(async () => {
    const raceTrack = deps.state.raceTrack;
    if (!raceTrack || !canRematch()) return;
    const g = hostBots.buildStartState(raceTrack);
    try {
      await session.start(g);
      // The host never left race mode when the race finished — an echo of our own
      // write will arrive via onGameState with an over→race transition and switch us
      // into the new race there. If that echo is delayed, fall back the same way startOnline does.
      if (deps.state.game?.phase === 'over') {
        deps.setGame(g);
        closeOverlay();
        deps.fitToContent();
        commitOnline();
      }
    } catch {
      showToast(strings.online.startFailed);
    }
  });
}

/** Leave the lobby: free the seat on the server and go back (host goes to mode select). */
function leaveLobby(): Promise<void> {
  return guarded(async () => {
    turnWatch.clearWatches();
    forgetSession(); // deliberate leave — nothing to come back to
    pendingCand = null;
    setMoveSendState('idle');
    setConnBanner(false);
    setLobbyStarting(false);
    const wasHost = deps.state.raceTrack !== null;
    await session.leave();
    if (wasHost) {
      deps.state.phase = 'modeSelect';
      deps.updateUI();
      deps.redraw();
    } else {
      deps.resetToEdit();
    }
  });
}

/** Share the game link (Web Share, or falling back to clipboard copy). */
async function shareLink(): Promise<void> {
  const code = session.getCode();
  if (!code) return;
  const url = `${location.origin}${import.meta.env.BASE_URL}?join=${code}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: strings.app.title, url });
    } catch {
      // User cancelled the share sheet — nothing to do.
    }
  } else {
    try {
      await navigator.clipboard.writeText(url);
      showToast(strings.online.copied);
    } catch {
      showToast(url);
    }
  }
}

/** Copy the game code to the clipboard. */
async function copyCode(): Promise<void> {
  const code = session.getCode();
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    showToast(strings.online.codeCopied);
  } catch {
    // Clipboard unavailable — the code is already visible on screen anyway.
  }
}

// ── Intents for panel buttons (bindButtons) and the invite link ─────────────────

/** "Play online": ask for a name and create the game as host. */
export function promptCreate(): void {
  openNameDialog(strings.online.create, savedName(), (name) => {
    rememberName(name);
    hostOnline(name);
  });
}

/** "Join by code": code+name dialog, errors are shown right in the dialog. */
export function promptJoin(): void {
  openJoinDialog(savedName(), '', (code, name) => {
    rememberName(name);
    joinOnline(code, name, true);
  });
}

/**
 * An invite link was opened (?join=CODE): connect to the game.
 * Re-joining a game we're already in the roster of (e.g. after a reload/reconnect) —
 * the name is already known, so skip asking and join right away. First-time joins
 * still ask for a name as before.
 */
export async function promptJoinByLink(code: string): Promise<void> {
  const known = await session.memberName(code);
  if (known) {
    rememberName(known);
    joinOnline(code, known, false);
    return;
  }
  openNameDialog(strings.online.joinSubmit, savedName(), (name) => {
    rememberName(name);
    joinOnline(code, name, false);
  });
}

/** Whether there's a remembered online session we could offer to resume. */
export function hasSavedSession(): boolean {
  return savedSession() !== null;
}

/**
 * One-shot prompt to resume the last online game (after a disconnect/reload). We
 * "consume" the breadcrumb as soon as we show the prompt: a "No" answer or an
 * unreachable game won't keep nagging, and on a successful join joinOnline will write
 * it again. Validation (is the game still alive, are we still in its roster) only
 * happens on "Yes" — we don't want a network request on every app start.
 */
export function promptResume(): void {
  const code = savedSession();
  if (!code) return;
  forgetSession();
  openConfirm(
    strings.online.resumeTitle(code),
    strings.online.resumeYes,
    async () => {
      const known = await session.memberName(code);
      if (!known) {
        showToast(strings.online.gameGone);
        return;
      }
      rememberName(known);
      joinOnline(code, known, false); // same path as reconnecting via link
    },
    { danger: false },
  );
}

export function start(): void {
  startOnline();
}
export function rematch(): void {
  rematchOnline();
}
export function leave(): void {
  leaveLobby();
}
export function share(): void {
  shareLink();
}
export function copy(): void {
  copyCode();
}

// Public API of the sub-modules used by main.ts, exposed through the controller facade:
// turn context/skip (turn-watch) and lobby bot management (host-bots).
export { skip, netTurn } from './turn-watch';
export { addBot, removeBot, setBotDifficulty } from './host-bots';
