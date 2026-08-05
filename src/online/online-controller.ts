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

import {
  GameState,
  Rules,
  Candidate,
  cloneState,
  isFinished,
  humansAllDone,
  hasLiveBots,
} from '../model/game';
import { applyMove, retireSeat } from '../model/turns';
import { editorFromTrack } from '../model/editor';
import {
  openJoinDialog,
  showJoinError,
  showErrorToast,
  showToast,
  setJoinBusy,
  setConnBanner,
} from '../ui/dialogs';
import { closeOverlay } from '../ui/dom';
import { openConfirm, openNotice } from '../ui/confirm';
import { AppState } from '../app-state';
import { RENAME_DEBOUNCE_MS } from '../config';
import { setMoveSendState } from '../ui/race-chrome';
import { describeSetupChanges } from '../ui/rules-summary';
import type { SettingChange, SetupSummary } from '../ui/rules-summary';
import { strings } from '../i18n';
import * as session from './online';
import { OnlineHandlers } from './online';
import type { LobbySetup } from './online';
import type { SerializedSetup } from './net';
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
    pushSetup,
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
 * "Send again". Identity guard: if an authoritative state (echo or someone else's
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
    showErrorToast(strings.online.error);
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

/**
 * Announce anyone who gave up between two states. Retirement never touches the roster
 * — it's a flag inside the race state — so it has to be spotted by diffing, unlike a
 * departure (see announceDepartures in online.ts).
 *
 * A seat already flagged `left` is skipped: walking out of a running race retires the
 * seat too, and "left the game" is the truer of the two. The leaver flags the seat
 * before writing the retirement precisely so this check sees it in time.
 *
 * Only for a race carrying on with the same lineup: a rematch brings a whole new
 * `players` array, where seat-by-seat comparison would be meaningless.
 */
function announceRetirements(before: GameState | null, after: GameState): void {
  if (!before || before.phase !== 'race' || after.phase === 'over') return;
  if (before.players.length !== after.players.length) return;
  const mine = session.mySeat();
  const roster = session.getRoster();
  after.players.forEach((p, seat) => {
    if (seat === mine || p.bot) return;
    if (!p.retired || before.players[seat].retired) return;
    if (roster[seat]?.left) return; // they didn't give up, they walked out
    showToast(strings.online.playerRetired(p.name));
  });
}

// ── Announcing the host's changes (guest side) ──────────────────────────────────
// A guest may be looking at any of the three lobby tabs — or at the roster, where a
// rules change leaves no trace at all — so every change the host makes is spoken
// aloud once. The announcement waits: the host writes with a debounce, but dragging
// through several values still lands several rows, and one toast per intermediate
// value would be worse than none. The window collects them, and the diff is taken
// against the setup the guest was last told about, never against the previous row.

/** How long changes are collected before they're announced, ms. */
const SETUP_NOTICE_MS = 3_000;

let noticeTimer: number | null = null;
/** The setup as last announced (the baseline for the next diff), while a window is open. */
let noticedSetup: SetupSummary | null = null;

function sayChanges(changes: SettingChange[]): void {
  if (!changes.length) return;
  // More than a couple of settings at once stops being informative and starts
  // being a wall of text — then just say that something moved.
  if (changes.length > 2) {
    showToast(strings.online.setupChangedMany, 3_000);
    return;
  }
  showToast(
    strings.online.setupChanged(changes.map((c) => `${c.label} — ${c.value}`).join(', ')),
    3_000,
  );
}

function announceSetupChange(before: LobbySetup, after: LobbySetup): void {
  if (!noticedSetup) noticedSetup = before;
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    noticeTimer = null;
    const base = noticedSetup;
    noticedSetup = null;
    if (base) sayChanges(describeSetupChanges(base, after));
  }, SETUP_NOTICE_MS);
}

/**
 * The race started while an announcement was still waiting. The rules inside the
 * state are the ones being raced, so the diff is redone against those and shown
 * immediately — a change nobody was told about is worse in a race than in a lobby.
 */
function flushSetupNotice(raced: Rules): void {
  if (noticeTimer === null) return;
  clearTimeout(noticeTimer);
  noticeTimer = null;
  const base = noticedSetup;
  noticedSetup = null;
  if (!base) return;
  // Bots are already visible on the grid by now — only the rules still need saying.
  sayChanges(describeSetupChanges(base, { rules: raced, bots: base.bots }));
}

/** Turn a join error into user-facing text. */
function joinErrorText(e: unknown): string {
  const m = (e as { message?: string })?.message ?? '';
  if (m.includes('game_not_found')) return strings.online.notFound;
  if (m.includes('game_full')) return strings.online.full;
  if (m.includes('game_started')) return strings.online.started;
  return strings.online.error;
}

/** Whether the notice below is already up, so a stream of events doesn't re-raise it. */
let stallNoticed = false;

/**
 * A guest's race that can no longer be finished: the creator has walked out, and bots
 * are still driving — and only the creator's client works out their moves, so the queue
 * stops at the first bot and never moves again. Nothing can be done in the room from
 * here, so say it plainly and hand over the way out rather than leaving everyone to
 * work out why nobody is moving. Without bots the race carries on without its creator,
 * which is the whole point of not deleting the room when they leave.
 */
function noticeHostStall(): void {
  const game = deps.state.game;
  const stalled =
    session.active() &&
    !session.isHost() &&
    session.hostGone() &&
    !!game &&
    game.phase === 'race' &&
    hasLiveBots(game);
  if (!stalled) {
    stallNoticed = false;
    return;
  }
  if (stallNoticed) return;
  stallNoticed = true;
  openNotice(strings.online.hostLeftStalled, strings.online.leaveRace, () =>
    leaveSession(),
  );
}

const handlers: OnlineHandlers = {
  onLobby: () => {
    // We're in a live lobby — remember the code for resuming after a disconnect (idempotent).
    rememberSession(session.getCode()!);
    if (deps.state.phase === 'lobby') deps.updateUI();
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
    announceRetirements(deps.state.game, g);
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
    // A setting changed in the last seconds of the lobby: the announcement is still
    // waiting out its window, and the race has started meanwhile. Say it now, against
    // the rules the race actually runs on — there's nothing left to wait for.
    flushSetupNotice(g.rules);
    // Last: the creator's departure arrives as a roster change on a state row, so this
    // is where a guest finds out the race has nowhere left to go.
    noticeHostStall();
  },
  onClosed: () => {
    turnWatch.clearWatches();
    forgetSession(); // the game was deleted/closed by the host — nothing to come back to
    stallNoticed = false;
    pendingCand = null;
    setMoveSendState('idle');
    setConnBanner(false);
    hostBots.setLobbyStarting(false);
    showErrorToast(strings.online.closed);
    deps.resetToEdit();
  },
  onPlayerLeft: (name) => {
    // News, not a failure — the neutral skin. Worth saying in both places: in the lobby
    // a seat frees up, and in a race a car goes quiet for a reason no one would guess.
    // Leaving outranks the retirement it implies mid-race; announceRetirements stays
    // quiet for a seat that's flagged gone, so a departure is announced once, as itself.
    showToast(strings.online.playerLeft(name));
  },
  onSetupChanged: (before, after) => {
    // The guest's lobby draws the host's settings (read-only tabs) and their bots
    // (roster rows) — both come off this, so a change has to reach the screen.
    deps.updateUI();
    announceSetupChange(before, after);
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
    }
    deps.updateUI();
  },
};

// ── The host's setup on the row ──────────────────────────────────────────────────
// Rules and the bot fill are the host's to choose and the guests' to see, and until
// the race starts the row is the only place they can meet (state is null). The write
// is debounced: dragging a slider is a stream of changes, and every row that lands
// raises a toast on the other side.

/** How long the host's settings have to settle before they're written, ms. */
const SETUP_DEBOUNCE_MS = 800;

let setupTimer: number | null = null;

/** The setup as it stands right now, in wire form. */
function currentSetup(): SerializedSetup {
  return { rules: deps.state.rules, bots: hostBots.lobbyBotConfig() };
}

function writeSetupNow(): void {
  session.writeSetup(currentSetup()).catch(() => {
    // A dropped setup write isn't worth interrupting the host over: the next change
    // (or the start of the race, which carries the rules in the state) writes it again.
  });
}

/**
 * The host changed something in the lobby — schedule the write. No-op for a guest
 * or outside a session (the local setup screens change the same rules).
 */
export function pushSetup(): void {
  if (!session.active() || !session.isHost()) return;
  if (setupTimer !== null) clearTimeout(setupTimer);
  setupTimer = window.setTimeout(() => {
    setupTimer = null;
    writeSetupNow();
  }, SETUP_DEBOUNCE_MS);
}

/**
 * Write a pending setup immediately. Called just before the race starts: a host who
 * tweaks a setting and hits "Start" right after would otherwise leave the row holding
 * the previous values, and the guest's "what changed" would be computed against a lie.
 */
function flushSetup(): void {
  if (setupTimer === null) return;
  clearTimeout(setupTimer);
  setupTimer = null;
  writeSetupNow();
}

/** Create an online game (as host) with the entered name and open the lobby. */
function hostOnline(name: string): Promise<void> {
  return guarded(async () => {
    const raceTrack = deps.state.raceTrack;
    if (!raceTrack) return;
    hostBots.resetBots(); // fresh lobby — no leftover bots from before
    try {
      await session.host(raceTrack, name, currentSetup(), handlers);
      deps.state.phase = 'lobby';
      deps.updateUI();
      deps.redraw();
    } catch {
      showErrorToast(strings.online.error);
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
      if (deps.state.phase === 'lobby') deps.updateUI();
    } catch (e) {
      if (inJoinDialog) {
        showJoinError(joinErrorText(e));
      } else {
        openJoinDialog(code, (code2) => joinOnline(code2, name, true));
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
    // A setting changed a moment ago may still be sitting in the debounce — get it
    // out before the state lands, so the lobby row never disagrees with the race.
    flushSetup();
    const g = hostBots.buildStartState(raceTrack);
    hostBots.setLobbyStarting(true);
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
      showErrorToast(strings.online.startFailed);
    } finally {
      hostBots.setLobbyStarting(false);
    }
  });
}

/** Whether this client can start a rematch: it's the host, nothing is left for the
 *  people to drive, and there is still someone to race against — in that case one tap
 *  replays the same track with the same lineup (the "Rematch" button on the results
 *  screen). Once the last guest has left, a rematch would be a lone drive around the
 *  track, so the button goes away and the results screen offers only the way out.
 *
 *  Not strictly `phase === 'over'`: once every human has a place or has retired, the
 *  race is decided as far as the room is concerned — waiting out a tail of bots before
 *  anyone may press Rematch is just a queue for nothing. */
export function canRematch(): boolean {
  const game = deps.state.game;
  return (
    session.isHost() &&
    !!game &&
    (game.phase === 'over' || humansAllDone(game)) &&
    session.activeRoster().length >= 2
  );
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
    // The button is only shown when a rematch is on, so landing here means the room
    // moved under us (the last guest left, someone's state arrived late). Say so —
    // a visible button that silently does nothing is the worst of both.
    if (!raceTrack || !canRematch()) {
      showErrorToast(strings.online.startFailed);
      return;
    }
    const g = hostBots.buildStartState(raceTrack);
    const prev = deps.state.game;
    try {
      await session.start(g);
      // The host never left race mode when the race finished — an echo of our own write
      // will arrive via onGameState and switch us into the new race there. If that echo
      // is delayed, fall back the same way startOnline does. Comparing against the state
      // we started from is what tells the two apart: the echo replaces the object.
      if (deps.state.game === prev) {
        deps.setGame(g);
        closeOverlay();
        deps.fitToContent();
        commitOnline();
      }
    } catch {
      showErrorToast(strings.online.startFailed);
    }
  });
}

/**
 * Retire our own seat if we're leaving a race that's still running. Reuses the same
 * confirm-first write as the retire button; a finished or already-retired seat, or a
 * session that never got past the lobby, has nothing to do here.
 */
async function retireBeforeLeaving(): Promise<void> {
  const game = deps.state.game;
  if (!game || game.phase !== 'race') return;
  const seat = session.mySeat();
  const me = game.players[seat];
  if (!me || isFinished(me) || me.retired) return;
  // Flag the seat as gone first, then retire it. Both reach the others as separate
  // realtime updates, and this order is what lets them tell the two apart: seeing
  // the flag first, they announce a departure and stay quiet about the retirement
  // that follows. The reverse order would announce a surrender by someone who has
  // in fact walked out.
  await session.markLeft();
  try {
    await confirmFirst(game, (next) => retireSeat(next, seat));
  } catch {
    // The seat stays live for the others; they'll auto-skip it as before. Leaving
    // must not be blocked by a failed write.
  }
}

/**
 * Leave the session for good: free the seat on the server and go back. Reached
 * from the lobby, and from the results screen when a guest doesn't want to wait
 * on the track creator's rematch — the room lives on either way, the rematch
 * just starts without us.
 *
 * Where "back" is follows who we are: the host still owns the drawn track
 * (`raceTrack`), so they land on mode select with it; a guest never had one
 * (nulled on join) and goes to a clean editor.
 */
function leaveSession(): Promise<void> {
  return guarded(async () => {
    // Walking out of a race we're still driving in is a retirement: the others keep
    // racing, and our car stops rather than standing there waiting for turns that never
    // come. Has to go first — session.leave() closes the channel before anything else,
    // and there's nowhere to write afterwards. Best-effort: a failed write must not
    // trap us in a session we've decided to leave.
    await retireBeforeLeaving();
    turnWatch.clearWatches();
    forgetSession(); // deliberate leave — nothing to come back to
    stallNoticed = false;
    pendingCand = null;
    setMoveSendState('idle');
    setConnBanner(false);
    hostBots.setLobbyStarting(false);
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

/**
 * "Play online": create the room straight away, under whatever name we're remembered
 * by (possibly none). Naming happens in the lobby now — the roster row is the field —
 * so there's nothing to ask before the room exists.
 */
export function promptCreate(): void {
  hostOnline(savedName());
}

/** "Join by code": the code dialog (the name is typed in the lobby), errors in place. */
export function promptJoin(): void {
  openJoinDialog('', (code) => joinOnline(code, savedName(), true));
}

// ── Renaming yourself in the lobby ──────────────────────────────────────────────
// Called on every keystroke in the roster's name field, so the write is debounced:
// one RPC per pause, not per character. The local roster is updated immediately
// (session.rename), so our own row never lags behind the keyboard.

let renameTimer: number | null = null;

export function setName(name: string): void {
  rememberName(name);
  // Locally first: the roster row, and with it the gate on "Start race", follow the
  // keyboard rather than the network.
  session.setLocalName(name);
  deps.updateUI();
  if (renameTimer !== null) clearTimeout(renameTimer);
  renameTimer = window.setTimeout(() => {
    renameTimer = null;
    session.rename(name).catch(() => {
      // A dropped rename isn't worth interrupting anyone over: the next keystroke
      // (or the resync on reconnect) writes it again.
    });
  }, RENAME_DEBOUNCE_MS);
}

/**
 * An invite link was opened (?join=CODE): connect to the game straight away. Nothing
 * is asked first — a seat in the lobby is the fastest thing we can give someone who
 * followed an invite, and the name is typed there. Re-joining a game we're already in
 * the roster of (a reload/reconnect) keeps the name we're already seated under.
 */
export async function promptJoinByLink(code: string): Promise<void> {
  const known = await session.memberName(code);
  if (known) rememberName(known);
  joinOnline(code, known ?? savedName(), false);
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
        showErrorToast(strings.online.gameGone);
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
  leaveSession();
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
export { lobbyView, setBotCount, setBotDifficulty } from './host-bots';
