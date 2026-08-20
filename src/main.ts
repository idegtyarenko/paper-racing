// The composition root: app state, switching between editor/race phases, and
// wiring up input/online/button dependencies. All game state lives in one
// object `S` (app-state.ts); online and input read and mutate it by reference
// through deps.state — there are no separate get/set adapters per field.
//
// What this file deliberately does NOT own (it used to, and grew into a
// god-module for it): pointer gestures (view/input.ts), the post-move tween
// (view/move-tween.ts), the replay (view/replay-player.ts + ui/screens/race-replay.ts
// for its chrome), the bots' clock in a local game (bots/scheduler.ts), the
// coach-mark's placement (ui/screens/editor-chrome.ts) and the build label
// (pwa.ts). Each of those arrives wired through an init* call below.

import './ui/styles/index.css';
import { newAppState } from './app-state';
import { finalizeTrack } from './model/track';
import {
  newEditor,
  stepBack,
  confirmEdges,
  confirmFinish,
  confirmDirection,
} from './model/editor';
import { Candidate, newGame, shuffledIndices, hasLiveBots } from './model/game';
import { candidatesForSeat, applyMove, retireSeat } from './model/turns';
import { SeatCtx, myTurn, candOwner, localHumanSeat, canRetire } from './seats';
import { Difficulty } from './model/ai';
import { buildNavField } from './model/nav';
import { initBotScheduler, scheduleBotMove, cancelBotMoves } from './bots/scheduler';
import { strings, localeTag } from './i18n';
import { render, AppView, MotionFrame } from './view/render';
import { stopAnim } from './view/anim';
import { initReplay, enterReplay, isReplaying } from './view/replay-player';
import { initMoveTween, noteMoves } from './view/move-tween';
import { Bounds, polylineBounds } from './view/camera';
import { boardInsets } from './ui/layout/board-insets';
import * as vp from './view/viewport';
import {
  actZoneHeight,
  chipRect,
  confirmBtnSize,
  initRaceChrome,
  renderRaceChrome,
  setActAnchor,
  setConfirmFloat,
  setMoveSendState,
  setTurnCountdown,
  showConfirmMove,
} from './ui/screens/race-chrome';
import { initRaceResult, renderRaceResult } from './ui/screens/race-result';
import { ScreenInput, raceChromeProps, raceResultProps } from './ui/present/screen-props';
import { showReplayChrome, hideReplayChrome } from './ui/screens/race-replay';
import {
  initEditorChrome,
  renderEditorChrome,
  updateCoachPlacement,
  setOnlineEnabled,
} from './ui/screens/editor-chrome';
import { initWizardNav, renderWizardNav, wizardSteps } from './ui/components/wizard-nav';
import { openConfirm, openNotice, closeNoticeIfOpen } from './ui/components/confirm';
import { initMenu, setVersionLabel } from './ui/components/menu';
import {
  initSetupChrome,
  renderSetupChrome,
  setSetupOnlineEnabled,
} from './ui/screens/setup-chrome';
import { initOnlineLobby, renderOnlineLobby } from './ui/screens/online-lobby';
import { onlineAvailable } from './online/net';
import * as session from './online/online';
import * as online from './online/online-controller';
import * as input from './view/input';
import { initInstallPrompt } from './ui/components/install-prompt';
import {
  openJoinDialog,
  openRules,
  setConnBanner,
  setJoinBusy,
  showErrorToast,
  showJoinError,
  showToast,
} from './ui/components/dialogs';
import { bindOverlayClose, closeOverlay } from './ui/primitives/dom';
import { describeSetupChanges } from './ui/present/rules-summary';
import type { SettingChange } from './ui/present/rules-summary';
import { initPwa, initBuildInfo } from './pwa';
import { initAppHeight } from './ui/layout/app-height';
import * as persist from './persist';

// Before anything measures the board: fixes the too-short viewport iOS hands a
// standalone PWA at launch (see ui/layout/app-height.ts).
initAppHeight();

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const wrap = document.querySelector('.app__board')!;

/** Single shared app state (see app-state.ts). Online/input get it by
 *  reference and read/write its fields directly. */
const S = newAppState();

/** Who this client is at the controls of, for the seat predicates (seats.ts).
 *  The one place the online/local difference is turned into data: our own seat
 *  in a room, null when the game is local. */
function seats(): SeatCtx {
  return { game: S.game, phase: S.phase, mySeat: mySeat() };
}

/** Our own seat in an online room, or null when the game is local — the one
 *  place the online/local difference is turned into data. */
function mySeat(): number | null {
  return session.active() ? session.mySeat() : null;
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

/** Current animated frame (post-move tween or replay), or null when still.
 *  The one frame slot on the board: the tween and the replay both write it
 *  through showFrame, and redraw() is the only reader. */
let motion: MotionFrame | null = null;

/** Put an animated frame on the board (or clear it and go back to the still
 *  picture). Handed to whoever animates — see view/move-tween.ts and
 *  view/replay-player.ts. */
function showFrame(m: MotionFrame | null): void {
  motion = m;
  redraw();
}
/** Drop any running animation and the frame it was drawing (leaving a race). */
function stopMotion(): void {
  stopAnim();
  motion = null;
}

function redraw(): void {
  // The player-selection step is drawn like the editor: shows the finished track as a preview.
  const viewMode = S.phase === 'race' ? 'race' : 'edit';
  const app: AppView = {
    mode: viewMode,
    editor: S.editor,
    game: S.game,
    // The replay is watched, not played: no fan, no aim line, no pending pick.
    cands: isReplaying() ? null : S.cands,
    hover: input.getHover(),
    selected: input.getSelected(),
    pending: S.pending,
    candSeat: candOwner(seats()),
    loupe: input.getLoupe(),
    cam: vp.camera(),
    motion: motion ?? undefined,
  };
  render(ctx, app);
  // The action zone and the floating "Go!" button are pinned to where the
  // candidates are on screen, so they follow every camera change — and a
  // camera change is exactly what a redraw is for.
  if (viewMode === 'race') input.updateConfirmPlacement();
  else
    updateCoachPlacement({
      editor: S.editor,
      cam: vp.camera(),
      view: vp.viewSize(),
      anchored: S.phase === 'edit',
    });
}

/** Everything the online layer knows that the screens need — fetched here so
 *  the presenters (ui/present/screen-props.ts) can stay pure. */
function screenInput(): ScreenInput {
  return {
    state: S,
    mySeat: mySeat(),
    net: online.netTurn(S.game),
    connected: session.isConnected(),
    hostGone: session.hostGone(),
    onlineCanRematch: online.canRematch(),
  };
}

function updateUI(): void {
  noteMoves();
  const screens = screenInput();
  renderRaceChrome(raceChromeProps(screens));
  renderRaceResult(raceResultProps(screens));
  renderEditorChrome(S.editor, S.phase);
  // The lobby view drives three renderers: the host's lobby is the setup screen
  // (so the wizard keeps its step), the guest's is a screen of its own.
  const lobby = S.phase === 'lobby' ? online.lobbyView() : null;
  renderSetupChrome(S.phase, S.raceTrack?.startPoints.length ?? 6, lobby);
  renderOnlineLobby(lobby?.isHost ? null : lobby, S.editor);
  renderWizardNav(S.phase, S.editor.step, S.playersReturn, !!lobby?.isHost);
}

/**
 * The player's hand is off the field — anything held back while it was on can
 * run now: the bot's move locally, the deferred board sync online. Each half is
 * a no-op where it doesn't apply, so both are simply called.
 */
function gestureEnded(): void {
  scheduleBotMove();
  online.syncAfterGesture();
}

/**
 * Single point for "state changed — bring the screen up to date":
 * recompute candidates → panel → canvas → (for a local game with bots) the
 * next bot move. Call this after any local state mutation instead of the
 * manual refreshCands/updateUI/redraw/scheduleBotMove sequence — that way a
 * step can't be forgotten or reordered. `fit` additionally fits the content
 * into frame (used when starting a race). Online drives its own redraw
 * through commitOnline (which needs armTurnWatch).
 */
function commit(opts: { fit?: boolean } = {}): void {
  refreshCands();
  updateUI();
  // Fit after updateUI, not before: the framing measures the side panels that
  // are actually on screen, and the screen we're leaving still has its panel up
  // until updateUI() takes it down. Fitting first frames the track into the
  // space beside a panel that's already on its way out — at a race start that
  // threw the whole track off to the right.
  if (opts.fit) vp.fitToContent();
  redraw();
  scheduleBotMove();
}

/**
 * Apply the chosen move: mutate local state, and in online games also send
 * it to the other players. Refuses to move outside our turn or outside the race phase.
 */
function commitMove(cand: Candidate): void {
  if (!S.game || S.game.phase !== 'race' || !myTurn(seats())) return;
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
  if (!canRetire(seats())) return;
  if (session.active()) {
    online.sendRetire();
    return;
  }
  retireSeat(S.game!, localHumanSeat(seats()));
  commit(); // after a human retires, the turn may move on to bots
}

function refreshCands(): void {
  input.clearSelection();
  const seat = candOwner(seats());
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
  // Arms the "Go!" button if a pending pick survived until our turn (one tap
  // confirms it), and places the action zone for the fresh candidates — the
  // chip and the countdown button are on screen from the start of the turn, so
  // where they sit can't wait for a pick.
  input.syncConfirmMove();
}

/**
 * Check the pending pick against fresh state: if the picked point is gone from
 * the fan or has become occupied by an opponent (they landed on it or on its
 * path — blocked), clear the pick with a toast; otherwise update the reference
 * to the current candidate object. A crash target is NOT a reason to clear:
 * going off the edge is a legal move the player picked on purpose (sometimes
 * the only one, sometimes the fastest), and input.ts lets it be picked — so
 * dropping it here would undo a deliberate choice. Called from refreshCands —
 * the single funnel for incoming state (onGameState in online, the bot loop).
 */
function revalidatePending(): void {
  if (!S.pending || !S.cands) return;
  const t = S.pending.target;
  const match = S.cands.find((c) => c.target.x === t.x && c.target.y === t.y);
  if (match && !match.blocked) {
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
  cancelBotMoves(); // a game with bots is paused while setup screens are open
  stopMotion();
  S.phase = 'modeSelect';
  commit();
}

/** Go back from the setup step (mode/players): to the editor or back to the current race. */
function backFromSetup(): void {
  if (S.playersReturn === 'race') {
    S.phase = 'race'; // commit() below resumes bot moves (mode gate in scheduleBotMove)
  } else {
    S.phase = 'edit';
    stepBack(S.editor); // ready → direction
  }
  S.raceTrack = null;
  commit();
}

/**
 * Jump back to an already-passed wizard step (a tap on the step rail): exactly
 * as many "Back"s as the player would have pressed, through the same
 * transitions. Reaching the drawing step resets the centerline (stepBack →
 * resetCenter), so that one jump asks first — everything else is reversible
 * enough to just happen.
 */
function goToWizardStep(target: number): void {
  const at = (): number => wizardSteps(S.phase, S.editor.step, S.playersReturn).active;
  if (target < 0 || at() < 0 || target >= at()) return;

  const oneStepBack = (): void => {
    if (S.phase === 'players' || S.phase === 'ai') S.phase = 'modeSelect';
    else if (S.phase === 'modeSelect') backFromSetup();
    else stepBack(S.editor);
  };
  const run = (): void => {
    // Bounded: a transition that refuses to move must not spin the loop.
    for (let guard = 0; guard < 10 && at() > target; guard++) oneStepBack();
    commit();
  };

  // Step 1 exists only in a run that starts in the editor; coming from a race
  // ("same track") there is nothing to erase.
  if (target === 0 && S.playersReturn === 'edit') {
    openConfirm(strings.wizard.resetWarn, strings.wizard.resetYes, run);
  } else {
    run();
  }
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
  cancelBotMoves();
  stopMotion();
  S.pending = null;
  S.game = newGame(S.raceTrack, humans + bots, S.rules, shuffledIndices(humans + bots));
  for (let i = humans; i < S.game.players.length; i++) {
    S.game.players[i].bot = difficulty;
  }
  S.raceNav = buildNavField(S.raceTrack); // needed by bots (chooseMove) and the standings strip
  S.lastLocalRace = { humans, bots, difficulty };
  S.phase = 'race';
  commit({ fit: true }); // fit puts the track in frame; scheduleBotMove kicks in if a bot moves first
}

/** Reset everything back to a clean editor (new track / leaving an online session). */
function resetToEdit(): void {
  // If we're still in an online session (e.g. we finished but another player
  // is still racing, and we hit "New race" → "Draw a new one") — leave it,
  // otherwise an incoming opponent move via onGameState would revive the
  // race and yank us out of the editor.
  if (session.active()) session.leave();
  cancelBotMoves();
  stopMotion();
  // This is a real exit, not a rematch — without this, an abandoned race
  // would come back on the next reload (persist.load() picks up any
  // snapshot on disk regardless of how we got to the editor).
  persist.clear();
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
/**
 * What the online layer is allowed to put on screen (OnlineUi). Mostly one-line
 * pass-throughs — the point is that online/ asks for them instead of importing
 * ui/ itself, so a redesign of the lobby or the settings screen stops here.
 */
const onlineUi: online.OnlineUi = {
  toast: showToast,
  errorToast: showErrorToast,
  connBanner: setConnBanner,
  moveSendState: setMoveSendState,
  confirm: (title, confirmLabel, onOk, opts) =>
    openConfirm(title, confirmLabel, onOk, opts),
  notice: openNotice,
  closeNotice: closeNoticeIfOpen,
  closeOverlay,
  joinDialog: openJoinDialog,
  joinError: showJoinError,
  joinBusy: setJoinBusy,
  saySetupChange: (before, after) => sayChanges(describeSetupChanges(before, after)),
};

/** The host's settings change, said out loud. */
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

online.initOnline({
  state: S,
  ui: onlineUi,
  setGame: (g) => {
    // An online race replaces the local one: stop the local bot loop (in
    // online games, the host drives bots through online-controller). Bot-ness
    // of the seats themselves lives in state g (Player.bot).
    cancelBotMoves();
    stopMotion();
    S.game = g;
    S.raceNav = g ? buildNavField(g.track) : null; // needed by bots (chooseMove) and the standings strip
    S.lastLocalRace = null; // an online race isn't a local rematch — clear "same track"
  },
  fitToContent: () => vp.fitToContent(),
  refreshCands,
  updateUI,
  setTurnCountdown,
  redraw,
  isGesturing: input.isGesturing,
  resetToEdit,
});

// Pointer gestures and zoom live in input.ts; it reads app state S by
// reference and applies moves through these callbacks, while keeping
// highlighting (hover/selected/loupe) to itself.
input.initInput({
  canvas,
  state: S,
  // Input decides where the confirm button and the status chip sit (it has the
  // camera and the candidate fan); this is its only hand on their DOM.
  chrome: {
    showConfirm: showConfirmMove,
    setActAnchor,
    setConfirmFloat,
    confirmSize: confirmBtnSize,
    chipRect,
    actZoneHeight,
  },
  commitMove,
  // Pre-pick mode: not our turn right now, but our seat can still queue a move (online/vs-bots).
  isPreselect: () => !myTurn(seats()) && candOwner(seats()) >= 0,
  myTurn: () => myTurn(seats()),
  setPending: (cand) => {
    S.pending = cand;
    showConfirmMove(false); // not our turn — don't show the button, the pending pick is visible on the field
    redraw();
  },
  updateUI,
  redraw,
  gestureEnded,
});

// Overlay dismissal (backdrop tap / Escape) for every sheet mounted into it.
bindOverlayClose();

// Step navigation for all six wizard steps. Built before the editor chrome,
// which mounts its coach card into the rail this owns.
initWizardNav({ onJumpTo: (index) => goToWizardStep(index) });

// The full-bleed editor chrome: coach-mark plus the drawing wizard's action bar.
initEditorChrome({
  onBack: () => {
    stepBack(S.editor);
    commit();
  },
  // Editor "Next" / "Choose mode": advance the drawing wizard one step. On the
  // final (direction) step this leaves the editor for mode selection.
  onNext: () => {
    const st = S.editor;
    if (st.step === 'adjust') confirmEdges(st);
    else if (st.step === 'finish') confirmFinish(st);
    else if (st.step === 'direction') {
      confirmDirection(st); // → transient 'ready'
      goToMode('edit'); // finalizes the track and opens mode selection (commits)
      return;
    }
    commit();
  },
  onJoinByCode: () => online.promptJoin(),
});

// The race HUD: classification card plus the action zone's confirm/skip buttons.
initRaceChrome({
  onShare: () => online.share(),
  onCopy: () => online.copy(),
  onConfirmMove: () => {
    const sel = input.getSelected();
    if (sel) commitMove(sel);
    // Our turn with a pending pick that survived: "Go!" commits it without a second tap.
    else if (S.pending && myTurn(seats())) commitMove(S.pending);
    else online.retryMove(); // desktop: no stored selection — retry the last move instead
  },
  onSkip: () => online.skip(),
});

// The car sliding into the move it just made (view/move-tween.ts) — spotted
// from updateUI, drawn through the same frame slot as the replay.
initMoveTween({ game: () => S.game, showFrame });

// The bots' clock in a local game (bots/scheduler.ts): it needs to read the
// state, know whether a finger is on the board and whether this is an online
// game (where the host moves the bots instead).
initBotScheduler({
  state: S,
  isGesturing: input.isGesturing,
  onlineActive: session.active,
  commit: () => commit(),
});

// Watching the finished race drive itself: the playback lives in
// view/replay-player.ts, the way out (a close button) in ui/screens/race-replay.ts.
initReplay({
  game: () => S.game,
  showFrame,
  showChrome: showReplayChrome,
  hideChrome: hideReplayChrome,
  refreshUI: updateUI,
});

// The result screen: outcome, final classification and the three ways on.
initRaceResult({
  // One-tap "Rematch": same lineup on the same track, no wizard. Online (as
  // host) replays the same room; locally it repeats the saved lineup. The
  // button is only shown when canRematch, but we guard here too.
  onRematch: () => {
    if (session.active()) {
      online.rematch();
      return;
    }
    if (!S.game || !S.lastLocalRace) return;
    S.raceTrack = S.game.track;
    startRace(S.lastLocalRace.humans, S.lastLocalRace.bots, S.lastLocalRace.difficulty);
  },
  // "Same track, new lineup": keep the track, re-pick the mode/players.
  onSameTrack: () => goToMode('race'),
  // "Draw a new track" online means leaving the room, and only the host works out
  // the bots' moves (host-bots.ts) — walking out mid-race freezes it for everyone
  // else. That's a warning, not a rule: a disabled button explains nothing and, as
  // it turned out, doesn't even read as disabled.
  onNewTrack: () => {
    if (session.active() && session.isHost() && S.game && hasLiveBots(S.game)) {
      openConfirm(strings.online.leaveBotsConfirm, strings.buttons.newTrack, resetToEdit);
      return;
    }
    resetToEdit();
  },
  // A guest done waiting on the track creator's rematch: free the seat and go
  // draw something. online.leave() lands a guest in the editor by itself, and
  // clears the resume breadcrumb so a reload doesn't drag us back in.
  onGuestLeave: () => online.leave(),
  // "Replay": watch this classification being driven, then come back to it.
  onReplay: enterReplay,
});

// The global menu's entries call the same intents the screens' own controls do.
// "Retire" is the menu's own — it only appears mid-race, and asks before
// dropping the player out.
initMenu({
  onRules: () => openRules(),
  onJoin: () => online.promptJoin(),
  canRetire: () => canRetire(seats()),
  onRetire: () =>
    openConfirm(strings.race.retireConfirmTitle, strings.race.retireConfirmYes, retire),
});

// Mode select + race setup: their own floating chrome, built on first show.
// The screens own the lineup (humans/bots/difficulty) and edit the race rules
// in place — including the host's lobby, which is one of these screens.
// The room's own actions, shared by the two lobby screens (the host's is the
// setup screen; the guest's is ui/screens/online-lobby.ts).
const lobbyHandlers = {
  onLobbyStart: () => online.start(),
  onLobbyCopyCode: () => online.copy(),
  onLobbyShare: () => online.share(),
  onLobbyLeave: () => online.leave(),
  onRename: (name: string) => online.setName(name),
};

initSetupChrome({
  onModeLocal: () => {
    S.phase = 'players';
    commit();
  },
  onModeOnline: () => online.promptCreate(),
  onModeAI: () => {
    S.phase = 'ai';
    commit();
  },
  onModeBack: () => backFromSetup(),
  // From either setup screen, "back" goes to mode selection (always present now).
  onSetupBack: () => {
    S.phase = 'modeSelect';
    commit();
  },
  onStartLocal: (humans, bots, difficulty) => startRace(humans, bots, difficulty),
  getRules: () => S.rules,
  onRulesChange: (r) => {
    S.rules = r;
    // In the host's lobby the same tabs configure a race other people are waiting
    // for — publish the change so their screens can show it (no-op offline).
    online.pushSetup();
  },
  ...lobbyHandlers,
  onLobbyBotCount: (n) => online.setBotCount(n),
  onLobbyBotDifficulty: (d) => online.setBotDifficulty(d),
});

// The guest's lobby: the same room, without anything to set up.
initOnlineLobby(lobbyHandlers);

// Mobile swipe-to-reload, the back gesture/button, closing or backgrounding
// the tab: pagehide catches unload and entering bfcache, visibilitychange
// catches backgrounding (the most reliable on phones, where a tab can be
// unloaded from the background without pagehide).
const saveState = (): void => persist.saveAppState(S, session.active());
window.addEventListener('pagehide', saveState);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveState();
});

// The document language follows the active locale (markup defaults to lang="en").
document.documentElement.lang = localeTag;

// Which build is running, and a heads-up when it changed (pwa.ts owns the
// question of what version the player has).
initBuildInfo({ toast: showToast, setLabel: setVersionLabel });

// Only show online entry points if the backend is configured (otherwise, local play only).
setOnlineEnabled(onlineAvailable());
setSetupOnlineEnabled(onlineAvailable());

// Camera: wire the viewport to the canvas/wrapper, the content bounds provider
// and the chrome insets — the framing has to work around the screen's side
// panel, and only ui/ knows which panel that is.
vp.initViewport(canvas, wrap, contentBounds, boardInsets);

// ResizeObserver instead of window.resize: the wrapper also changes size on
// layout changes (portrait/landscape on mobile), not just the window.
new ResizeObserver(resize).observe(wrap);

// An invite link is open (?join=CODE) — join that game (if we've been here
// before, the name is already known, otherwise we'll ask). Otherwise, restore
// the local game saved before the last page unload.
const joinParam = new URLSearchParams(location.search).get('join');
const joining = !!joinParam && onlineAvailable();
if (!joining && persist.restoreAppState(S) === 'race') {
  refreshCands(); // bring back move candidates for the restored race
  scheduleBotMove(); // resume bot moves if this was a game with bots
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
      candOwner: () => candOwner(seats()),
      cancelBotMoves,
      commitMove,
      myTurn: () => myTurn(seats()),
    }),
  );
}
