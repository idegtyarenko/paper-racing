// Orchestration: app state, switching between editor/race phases, and wiring
// up input/online/button dependencies. Actual pointer gestures live in
// input.ts. All game state lives in one object `S` (app-state.ts); online and
// input read and mutate it by reference through deps.state — there are no
// separate get/set adapters per field anymore.

import './ui/styles/index.css';
import { newAppState, Phase } from './app-state';
import { finalizeTrack } from './model/track';
import { newEditor, stepBack, confirmEdges } from './model/editor';
import {
  Candidate,
  normalizeRules,
  newGame,
  shuffledIndices,
  isFinished,
} from './model/game';
import { candidatesForSeat, applyMove, coastMove, retireSeat } from './model/turns';
import { Difficulty, chooseMove } from './model/ai';
import { buildNavField } from './model/nav';
import { strings, localeTag, dateLocale } from './i18n';
import { AI_MOVE_DELAY_MS } from './config';
import { render, AppView } from './view/render';
import { Bounds, polylineBounds } from './view/camera';
import * as vp from './view/viewport';
import {
  bindButtons,
  updatePanel,
  setOnlineEnabled,
  setTurnCountdown,
  showConfirmMove,
} from './ui/panel';
import { renderTurnQueue } from './ui/turn-queue';
import { renderStandings } from './ui/standings';
import { openSettings } from './ui/settings';
import { localizeDom } from './ui/localize';
import { onlineAvailable } from './online/net';
import * as session from './online/online';
import * as online from './online/online-controller';
import * as input from './view/input';
import { initInstallPrompt } from './ui/install-prompt';
import { showToast } from './ui/dialogs';
import { initPwa } from './pwa';
import { toggleSwDebug } from './sw-debug';
import * as persist from './persist';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const wrap = document.querySelector('.app__board')!;

/** Single shared app state (see app-state.ts). Online/input get it by
 *  reference and read/write its fields directly. */
const S = newAppState();
/** Timer for the delayed bot move — not state, just a handle: stays private
 *  to main.ts, we don't put it in S. Cleared on any exit from the race. */
let aiTimer: number | null = null;

/** Is this seat a bot (and at what difficulty)? Bot-ness lives in state (Player.bot). */
function isBotSeat(i: number): boolean {
  return !!S.game?.players[i]?.bot;
}

/** Bbox of the content for fit/clamp: the race track or the track being
 *  edited. The bounds provider for the viewport — the app knows "what's
 *  currently on screen". */
function contentBounds(): Bounds | null {
  if (S.phase === 'race' && S.game)
    return polylineBounds(S.game.track.outer, S.game.track.inner);
  return polylineBounds(S.editor.outer, S.editor.inner, S.editor.center);
}

/** Recompute the viewport for the new field size and redraw. */
function resize(): void {
  vp.resize();
  redraw();
}

function redraw(): void {
  // The player-selection step is drawn like the editor: shows the finished track as a preview.
  const viewMode = S.phase === 'race' ? 'race' : 'edit';
  const app: AppView = {
    mode: viewMode,
    editor: S.editor,
    game: S.game,
    cands: S.cands,
    hover: input.getHover(),
    selected: input.getSelected(),
    pending: S.pending,
    candSeat: candOwner(),
    loupe: input.getLoupe(),
    cam: vp.camera(),
  };
  render(ctx, app);
}

/**
 * The one human seat in a local game (all others are bots): this is who we
 * show the candidate fan/pre-pick to during a bot's turn. −1 if there isn't
 * exactly one human (hotseat with multiple humans doesn't get pre-picking).
 * Online doesn't look at this.
 */
function soloHumanSeat(): number {
  if (!S.game) return -1;
  let seat = -1;
  for (let i = 0; i < S.game.players.length; i++) {
    if (S.game.players[i].bot) continue;
    if (seat !== -1) return -1; // a second human means hotseat, not vs-bots
    seat = i;
  }
  return seat;
}

/**
 * The seat we show the candidate fan for and allow pre-picking on —
 * regardless of whose turn it currently is: online → our own seat; local
 * vs-bots → the one human. Requires the seat to be active (not in gravel,
 * not finished, not retired). −1 means pre-picking is unavailable (including
 * hotseat). On our own turn this matches game.current, so normal play
 * follows the same path.
 */
function preselectSeat(): number {
  if (S.phase !== 'race' || !S.game || S.game.phase !== 'race') return -1;
  const seat = session.active() ? session.mySeat() : soloHumanSeat();
  if (seat < 0) return -1;
  const p = S.game.players[seat];
  if (isFinished(p) || p.retired || p.skipTurns !== 0) return -1;
  return seat;
}

/**
 * The seat whose candidate fan we currently show/interact with: on our turn
 * it's whoever's moving (`game.current`) in any mode (hotseat/vs-bots/
 * online); on someone else's turn it's the pre-pick seat (`preselectSeat`,
 * online/vs-bots only). −1 means there are no candidates (someone else's
 * turn in hotseat, a penalty, or outside the race). On our own turn this
 * gives the same fan as before.
 */
function candOwner(): number {
  if (!S.game || S.game.phase !== 'race') return -1;
  if (myTurn())
    return S.game.players[S.game.current].skipTurns === 0 ? S.game.current : -1;
  return preselectSeat();
}

/**
 * The local player's seat for the "Retire" button: in online it's our own
 * seat; locally it's the current mover if they're human (nobody to retire
 * during a bot's turn — the button is hidden). −1 if there's no race or a
 * bot is currently moving.
 */
function localHumanSeat(): number {
  if (!S.game) return -1;
  if (session.active()) return session.mySeat();
  return isBotSeat(S.game.current) ? -1 : S.game.current;
}

/** Whether the "Retire" button is currently available: the race is running
 *  and the local player is still in it (not finished, not retired). Retiring
 *  is allowed at any time, not just on our turn. */
function canRetire(): boolean {
  if (!S.game || S.phase !== 'race' || S.game.phase !== 'race') return false;
  const seat = localHumanSeat();
  return seat >= 0 && !isFinished(S.game.players[seat]) && !S.game.players[seat].retired;
}

function updateUI(): void {
  const net = online.netTurn(S.game);
  const aiTurn = !!S.game && isBotSeat(S.game.current);
  updatePanel({
    phase: S.phase,
    editor: S.editor,
    game: S.game,
    playersMax: S.raceTrack?.startPoints.length ?? 6,
    net,
    aiTurn,
    canRetire: canRetire(),
  });
  renderTurnQueue(S.phase === 'race' ? S.game : null);
  renderStandings(S.phase === 'race' ? S.game : null, S.raceNav);
}

/** Can this client move right now: in a local game, always (except during a
 *  bot's turn); in online, only on our own seat. */
function myTurn(): boolean {
  if (S.game && isBotSeat(S.game.current)) return false;
  if (!session.active()) return true;
  return S.game !== null && session.mySeat() === S.game.current;
}

function cancelAiMove(): void {
  if (aiTimer !== null) {
    clearTimeout(aiTimer);
    aiTimer = null;
  }
}

/**
 * Bot-move loop for a LOCAL game: if it's currently a bot's turn, make its
 * move after a short pause (giving the human time to follow along), and keep
 * going until the turn returns to a human or the race ends. Doesn't run in
 * online games — there, bot moves are computed and committed by the host
 * through online-controller (otherwise the local applyMove would diverge
 * from the server). The pause is cleared on any exit from the race
 * (cancelAiMove).
 */
function scheduleAiMove(): void {
  if (aiTimer !== null || session.active()) return;
  // Mode gate: bots only move during an actually open race. While the setup
  // screen is open (mode !== 'race'), bots are paused even if game is still
  // in phase 'race'. Without this check, commit() from menu transitions
  // would trigger a bot move behind the setup screen.
  if (
    S.phase !== 'race' ||
    !S.game ||
    S.game.phase !== 'race' ||
    !isBotSeat(S.game.current)
  )
    return;
  aiTimer = window.setTimeout(() => {
    aiTimer = null;
    if (!S.game || S.game.phase !== 'race' || !isBotSeat(S.game.current) || !S.raceNav)
      return;
    const cand = chooseMove(S.game, S.raceNav, S.game.players[S.game.current].bot!);
    if (cand) applyMove(S.game, cand);
    else coastMove(S.game); // all candidates are taken by opponents — coast instead
    commit();
  }, AI_MOVE_DELAY_MS);
}

/**
 * Single point for "state changed — bring the screen up to date":
 * recompute candidates → panel → canvas → (for a local game with bots) the
 * next bot move. Call this after any local state mutation instead of the
 * manual refreshCands/updateUI/redraw/scheduleAiMove sequence — that way a
 * step can't be forgotten or reordered. `fit` additionally fits the content
 * into frame (used when starting a race). Online drives its own redraw
 * through commitOnline (which needs armTurnWatch).
 */
function commit(opts: { fit?: boolean } = {}): void {
  if (opts.fit) vp.fitToContent();
  refreshCands();
  updateUI();
  redraw();
  scheduleAiMove();
}

/**
 * Apply the chosen move: mutate local state, and in online games also send
 * it to the other players. Refuses to move outside our turn or outside the race phase.
 */
function commitMove(cand: Candidate): void {
  if (!S.game || S.game.phase !== 'race' || !myTurn()) return;
  S.pending = null; // move made — the pending pick is spent
  if (session.active()) {
    // Online: confirm-first — local state only advances after a successful
    // write (see online.sendMove), so a dropped connection doesn't lose the
    // move and it can be retried.
    online.sendMove(cand);
    return;
  }
  applyMove(S.game, cand);
  commit(); // in a game with bots, after the human's move the turn moves on to them
}

/**
 * Retire: the local player drops out of the race. Available at any time
 * (not just on our turn). In online, a confirm-first send; locally, mutate
 * state and redraw. The button is shown/hidden based on canRetire().
 */
function retire(): void {
  if (!canRetire()) return;
  if (session.active()) {
    online.sendRetire();
    return;
  }
  retireSeat(S.game!, localHumanSeat());
  commit(); // after a human retires, the turn may move on to bots
}

function refreshCands(): void {
  input.clearSelection();
  const seat = candOwner();
  if (seat < 0) {
    S.cands = null;
    S.pending = null;
    return;
  }
  // On our turn seat === game.current (normal play); on someone else's turn
  // (online/vs-bots) it's our own seat, so we can pre-pick a move ahead of time.
  S.cands = candidatesForSeat(S.game!, seat);
  revalidatePending();
  // The cursor may have been resting on a point while an opponent's move came
  // in (pre-pick mode) — restore hover from the actual mouse position, since
  // clearSelection above would have cleared it.
  input.reaimHover();
  // A pending pick survived until our turn — arm the "Go!" button so it can be confirmed with one tap.
  if (myTurn() && S.pending) showConfirmMove(true, input.confirmAnchor());
}

/**
 * Check the pending pick against fresh state: if the picked point has become
 * occupied by an opponent (they landed on it or on its path — blocked) or is
 * now a crash, clear the pick with a toast; otherwise update the reference to
 * the current candidate object. Called from refreshCands — the single funnel
 * for incoming state (onGameState in online, the local bot loop).
 */
function revalidatePending(): void {
  if (!S.pending || !S.cands) return;
  const t = S.pending.target;
  const match = S.cands.find((c) => c.target.x === t.x && c.target.y === t.y);
  if (match && !match.blocked && !match.crash) {
    S.pending = match;
  } else {
    S.pending = null;
    showToast(strings.race.preselectCleared);
  }
}

/**
 * Move to the mode-selection step. From the editor ("edit"), finalize the
 * drawn track first; if that fails, show the error and stay in the editor.
 * From a race ("race", "same track"), reuse the current race's finished
 * track. The mode-selection screen is always shown, even without online —
 * it's also where "vs Computer" is chosen.
 */
function goToMode(from: 'edit' | 'race'): void {
  if (from === 'edit') {
    const res = finalizeTrack(
      S.editor.outer!,
      S.editor.inner!,
      S.editor.finish!,
      S.editor.forward!,
    );
    if ('error' in res) {
      S.editor.message = res.error;
      S.editor.error = true;
      commit();
      return;
    }
    S.raceTrack = res.track;
  } else {
    if (!S.game) return;
    S.raceTrack = S.game.track;
  }
  S.playersReturn = from;
  cancelAiMove(); // a game with bots is paused while setup screens are open
  S.phase = 'modeSelect';
  commit();
}

/** Go back from the setup step (mode/players): to the editor or back to the current race. */
function backFromSetup(): void {
  if (S.playersReturn === 'race') {
    S.phase = 'race'; // commit() below resumes bot moves (mode gate in scheduleAiMove)
  } else {
    S.phase = 'edit';
    stepBack(S.editor); // ready → direction
  }
  S.raceTrack = null;
  commit();
}

/**
 * Start a local race on the prepared track: `humans` seats first, then
 * `bots` seats at the given difficulty. Bots sit in the trailing seats
 * (seat index), but starting cells are handed out by a random permutation
 * across all participants — so pole position can go to a bot too (starting
 * position is no longer tied to who "joined" earlier). The total participant
 * count is clamped by the starting grid inside newGame; `difficulty` doesn't
 * matter when bots = 0. The bot picks moves using the same target generator
 * as the engine, so it plays the actual race physics — there's no separate
 * "classic mode for bots".
 */
function startRace(humans: number, bots: number, difficulty: Difficulty): void {
  if (!S.raceTrack) return;
  cancelAiMove();
  S.pending = null;
  S.game = newGame(S.raceTrack, humans + bots, S.rules, shuffledIndices(humans + bots));
  for (let i = humans; i < S.game.players.length; i++) {
    S.game.players[i].bot = difficulty;
    S.game.players[i].name = `${strings.aiSelect.botPrefix} ${S.game.players[i].name}`;
  }
  S.raceNav = buildNavField(S.raceTrack); // needed by bots (chooseMove) and the standings strip
  S.lastLocalRace = { humans, bots, difficulty };
  S.phase = 'race';
  commit({ fit: true }); // fit puts the track in frame; scheduleAiMove kicks in if a bot moves first
}

/** Reset everything back to a clean editor (new track / leaving an online session). */
function resetToEdit(): void {
  // If we're still in an online session (e.g. we finished but another player
  // is still racing, and we hit "New race" → "Draw a new one") — leave it,
  // otherwise an incoming opponent move via onGameState would revive the
  // race and yank us out of the editor.
  if (session.active()) session.leave();
  cancelAiMove();
  S.game = null;
  S.raceNav = null;
  S.raceTrack = null;
  S.cands = null;
  S.pending = null;
  input.clearSelection();
  S.editor = newEditor();
  S.phase = 'edit';
  // Empty field → resize() shows the default view (no content bounds to fit).
  updateUI();
  resize();
}

// The online flow (host/join/start/leave/share) lives in online-controller.ts;
// it reads and mutates app state S by reference, and does redraws/resets
// through callbacks. setGame is a callback (not a direct S.game write)
// because it has side effects.
online.initOnline({
  state: S,
  setGame: (g) => {
    // An online race replaces the local one: stop the local bot loop (in
    // online games, the host drives bots through online-controller). Bot-ness
    // of the seats themselves lives in state g (Player.bot).
    cancelAiMove();
    S.game = g;
    S.raceNav = g ? buildNavField(g.track) : null; // needed by bots (chooseMove) and the standings strip
    S.lastLocalRace = null; // an online race isn't a local rematch — clear "same track"
  },
  fitToContent: () => vp.fitToContent(),
  refreshCands,
  updateUI,
  setTurnCountdown,
  redraw,
  resetToEdit,
});

// Pointer gestures and zoom live in input.ts; it reads app state S by
// reference and applies moves through these callbacks, while keeping
// highlighting (hover/selected/loupe) to itself.
input.initInput({
  canvas,
  state: S,
  commitMove,
  // Pre-pick mode: not our turn right now, but our seat can still queue a move (online/vs-bots).
  isPreselect: () => !myTurn() && candOwner() >= 0,
  setPending: (cand) => {
    S.pending = cand;
    showConfirmMove(false); // not our turn — don't show the button, the pending pick is visible on the field
    redraw();
  },
  goToMode,
  updateUI,
  redraw,
});

bindButtons({
  onBack: () => {
    stepBack(S.editor);
    commit();
  },
  onNext: () => {
    confirmEdges(S.editor);
    commit();
  },
  onConfirmMove: () => {
    const sel = input.getSelected();
    if (sel) commitMove(sel);
    // Our turn with a pending pick that survived: "Go!" commits it without a second tap.
    else if (S.pending && myTurn()) commitMove(S.pending);
    else online.retryMove(); // desktop: no stored selection — retry the last move instead
  },
  // One-tap "Rematch": same lineup on the same track, no wizard. In online
  // (as host) we replay the same room; locally we repeat the saved lineup.
  // The button is only shown when canRematch, but we guard here too.
  onChooseSameTrack: () => {
    if (session.active()) {
      online.rematch();
      return;
    }
    if (!S.game || !S.lastLocalRace) return;
    S.raceTrack = S.game.track;
    startRace(S.lastLocalRace.humans, S.lastLocalRace.bots, S.lastLocalRace.difficulty);
  },
  // "Same track, different mode": keep the track, re-pick the mode/players.
  onSameTrackNewMode: () => goToMode('race'),
  canRematch: () => (!!S.game && !!S.lastLocalRace) || online.canRematch(),
  isOnline: () => session.active(),
  onPlayersBack: () => {
    // From the player-count screen, "back" goes to mode selection (it's always present now).
    S.phase = 'modeSelect';
    commit();
  },
  onStartLocal: (humans, bots, difficulty) => startRace(humans, bots, difficulty),
  onOpenSettings: () =>
    openSettings(S.rules, false, (r) => {
      S.rules = r;
    }),
  onLobbySettings: () =>
    openSettings(S.rules, true, (r) => {
      S.rules = r;
    }),
  onNewTrack: () => resetToEdit(),
  onModeLocal: () => {
    S.phase = 'players';
    commit();
  },
  onModeOnline: () => online.promptCreate(),
  onModeAI: () => {
    S.phase = 'ai';
    commit();
  },
  onAiBack: () => {
    S.phase = 'modeSelect';
    commit();
  },
  onModeBack: () => backFromSetup(),
  onJoinByCode: () => online.promptJoin(),
  onLobbyStart: () => online.start(),
  onLobbyShare: () => online.share(),
  onLobbyCopyCode: () => online.copy(),
  onLobbyBotAdd: () => online.addBot(),
  onLobbyBotRemove: () => online.removeBot(),
  onLobbyBotDifficulty: (d) => online.setBotDifficulty(d),
  onLobbyLeave: () => online.leave(),
  onSkip: () => online.skip(),
  onRaceShare: () => online.share(),
  onRetire: () => retire(),
});

/**
 * Save local game state so reloading/the back gesture/backgrounding the tab
 * doesn't reset the game to the first screen. We don't save the online
 * session (it lives on the server) — instead we clear any previous local
 * snapshot. persist itself only takes the persistent subset of S
 * (cands/pending/raceNav are not written).
 */
function saveState(): void {
  if (session.active()) {
    persist.clear();
    return;
  }
  persist.save(S);
}

/** Restore local state from a snapshot. Returns the restored phase (or null if there was no snapshot). */
function restoreState(): Phase | null {
  const snap = persist.load();
  if (!snap) return null;
  S.phase = snap.phase;
  S.editor = snap.editor;
  S.raceTrack = snap.raceTrack;
  S.game = snap.game;
  // Backfill defaults: the snapshot may have been written by an older
  // version without newer rules fields (e.g. turnLimitMs) — otherwise
  // they'd come out undefined. This is the same fix net.ts applies to
  // server state on deserialization.
  S.rules = normalizeRules(snap.rules);
  S.playersReturn = snap.playersReturn;
  S.lastLocalRace = snap.lastLocalRace;
  // The nav field isn't serialized — rebuild it from the track (needed by
  // bots and the standings strip). Bot-ness of seats travels inside
  // game.players (Player.bot) — not restored separately.
  if (S.game) S.raceNav = buildNavField(S.game.track);
  return snap.phase;
}

// Mobile swipe-to-reload, the back gesture/button, closing or backgrounding
// the tab: pagehide catches unload and entering bfcache, visibilitychange
// catches backgrounding (the most reliable on phones, where a tab can be
// unloaded from the background without pagehide).
window.addEventListener('pagehide', saveState);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveState();
});

// Fill in static markup text from strings before the panel is first shown,
// and set the document language to the active locale (markup defaults to lang="en").
document.documentElement.lang = localeTag;
localizeDom();

// Build label at the bottom of the "Rules" sheet — an honest indicator of
// which code is actually running (the string is compiled into the bundle):
// commit + build time. Time is formatted in the local hour so "just now"
// matches the wall clock.
const buildLabel = new Date(__BUILD_TIME__).toLocaleString(dateLocale, {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const appVersionEl = document.getElementById('appVersion')!;
appVersionEl.textContent = `${__COMMIT__} · ${buildLabel}`;

// Hidden activation of SW debug from inside the app: a standalone PWA has
// its own localStorage bucket (the `?swdebug` flag from Safari doesn't carry
// over) and no address bar — toggle the overlay with 5 quick taps on the
// build label in "Rules".
let verTaps = 0;
let verTapT = 0;
appVersionEl.addEventListener('click', () => {
  const now = performance.now();
  verTaps = now - verTapT < 600 ? verTaps + 1 : 1;
  verTapT = now;
  if (verTaps < 5) return;
  verTaps = 0;
  const on = toggleSwDebug();
  showToast(on ? 'SW debug ON' : 'SW debug OFF', 1500);
  setTimeout(() => location.reload(), 400);
});

// If the commit changed since the last run, the app was updated: show a toast.
// We compare the compiled-in commit to the saved one, without relying on SW mechanics.
try {
  const BUILD_KEY = 'pr-build';
  const seen = localStorage.getItem(BUILD_KEY);
  if (seen && seen !== __COMMIT__) {
    showToast(strings.race.updated, 3000);
  }
  localStorage.setItem(BUILD_KEY, __COMMIT__);
} catch {
  // private browsing / localStorage unavailable — fail silently
}

// Only show online entry points if the backend is configured (otherwise, local play only).
setOnlineEnabled(onlineAvailable());

// Camera: wire the viewport to the canvas/wrapper and the content bounds provider.
vp.initViewport(canvas, wrap, contentBounds);

// ResizeObserver instead of window.resize: the wrapper also changes size on
// layout changes (portrait/landscape on mobile), not just the window.
new ResizeObserver(resize).observe(wrap);

// An invite link is open (?join=CODE) — join that game (if we've been here
// before, the name is already known, otherwise we'll ask). Otherwise, restore
// the local game saved before the last page unload.
const joinParam = new URLSearchParams(location.search).get('join');
const joining = !!joinParam && onlineAvailable();
if (!joining && restoreState() === 'race') {
  refreshCands(); // bring back move candidates for the restored race
  scheduleAiMove(); // resume bot moves if this was a game with bots
}

updateUI();
resize(); // resize() itself fits the restored track/race into frame (fit-to-content)

if (joining) {
  online.promptJoinByLink(joinParam!.toUpperCase());
} else if (onlineAvailable() && online.hasSavedSession()) {
  // Reconnecting after a disconnect: offer to return to the last online game.
  online.promptResume();
}

// Offer to install the game as a home-screen shortcut (Android/Chromium and iOS Safari).
initInstallPrompt();

// Register the service worker: PWA updates are applied by the client at a
// safe moment (not mid-race) — see src/pwa.ts. The "can we reload" predicate
// is false only during an active race.
initPwa(() => !(S.phase === 'race' && S.game != null && S.game.phase === 'race'));

// ─── Dev-only test helpers (`window.__pr`) ─────────────────────────────────
// Manual helpers for browser-based validation live in a separate dev-only
// module `dev-helpers.ts` and are wired in via dynamic import only under
// `import.meta.env.DEV`. THEY DO NOT END UP IN THE PROD BUNDLE: Vite replaces
// `import.meta.env.DEV` with `false`, the import branch is eliminated as dead
// code, and the dev-helpers chunk is never created — verified via
// `npm run build` + grep over dist. None of this is visible to end users.
if (import.meta.env.DEV) {
  void import('./dev-helpers').then(({ installDevHelpers }) =>
    installDevHelpers({
      S,
      canvas,
      startRace,
      refreshCands,
      updateUI,
      redraw,
      candOwner,
      cancelAiMove,
      commitMove,
      myTurn,
    }),
  );
}
