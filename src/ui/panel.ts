// Side panel: owns its DOM elements and refreshes them from game state.
// Dialogs (name/code/toast) and the lobby screen live in sibling modules;
// bindButtons is the single point where all handlers get wired up, composing
// their setup.

import { KMH_PER_CELL } from '../config';
import { Phase } from '../app-state';
import { EditorState, EditorStep, canStepBack } from '../model/editor';
import { GameState, Player, MIN_PLAYERS } from '../model/game';
import { Difficulty } from '../model/ai';
import { msToClock } from './format';
import { len } from '../geometry';
import { strings } from '../i18n';
import { coarsePointer, bindTap, openSheet, closeOverlay, bindOverlayClose } from './dom';
import { openConfirm } from './confirm';
import { div, renderStepStatus, statusElement } from './status';
import { bindDialogs } from './dialogs';
import { bindSettings } from './settings';
import { bindLobby } from './lobby';

const statusEl = statusElement();

const editButtons = document.getElementById('editButtons')!;
const modeButtons = document.getElementById('modeButtons')!;
const aiButtons = document.getElementById('aiButtons')!;
const lobbyButtons = document.getElementById('lobbyButtons')!;
const playersButtons = document.getElementById('playersButtons')!;
const raceButtons = document.getElementById('raceButtons')!;
const backBtn = document.getElementById('backBtn') as HTMLButtonElement;
const nextBtn = document.getElementById('nextBtn') as HTMLButtonElement;
const playersBackBtn = document.getElementById('playersBack') as HTMLButtonElement;
const helpBtn = document.getElementById('helpBtn') as HTMLButtonElement;
const newRaceBtn = document.getElementById('newRace') as HTMLButtonElement;
const retireBtn = document.getElementById('retireBtn') as HTMLButtonElement;
const settingsBtn = document.getElementById('settingsBtn') as HTMLButtonElement;
const confirmMoveBtn = document.getElementById('confirmMove') as HTMLButtonElement;
const skipBtn = document.getElementById('skipTurn') as HTMLButtonElement;
const raceCodeBtn = document.getElementById('raceCode') as HTMLButtonElement;
const rulesSheet = document.getElementById('rulesSheet')!;
const raceDialog = document.getElementById('raceDialog')!;
const dlgSameTrack = document.getElementById('dlgSameTrack') as HTMLButtonElement;
const dlgSameTrackNewMode = document.getElementById(
  'dlgSameTrackNewMode',
) as HTMLButtonElement;
const dlgNewTrack = document.getElementById('dlgNewTrack') as HTMLButtonElement;
const winnerBanner = document.querySelector('.winner')!;
const winnerWho = winnerBanner.querySelector('.winner__title') as HTMLElement;

// Hotseat setup screen: "Humans", "Bots", "Difficulty" rows (the last one
// shown when bots ≥ 1) and the start button.
const humanCount = document.getElementById('humanCount')!;
const playersBotCount = document.getElementById('playersBotCount')!;
const playersDifficulty = document.getElementById('playersDifficulty')!;
const playersStartBtn = document.getElementById('playersStart') as HTMLButtonElement;

// Online mode: mode-selection buttons (the lobby and dialogs live in sibling modules).
const modeLocalBtn = document.getElementById('modeLocal') as HTMLButtonElement;
const modeOnlineBtn = document.getElementById('modeOnline') as HTMLButtonElement;
const modeBackBtn = document.getElementById('modeBack') as HTMLButtonElement;
const joinByCodeBtn = document.getElementById('joinByCode') as HTMLButtonElement;

// "Vs. computer" mode: the mode button, "Bots" (1–5) and "Difficulty" rows, and start.
const modeAiBtn = document.getElementById('modeAI') as HTMLButtonElement;
const aiBotCount = document.getElementById('aiBotCount')!;
const aiDifficulty = document.getElementById('aiDifficulty')!;
const aiStartBtn = document.getElementById('aiStart') as HTMLButtonElement;
const aiSettingsBtn = document.getElementById('aiSettingsBtn') as HTMLButtonElement;
const aiBackBtn = document.getElementById('aiBack') as HTMLButtonElement;

// ── Setup-screen state (humans/bots/difficulty) ───────────────────────────────
// A local race is assembled on the "Same device" (hotseat) and "Vs. computer"
// (single human always) screens. The number of grid seats (capacity) arrives
// via updatePanel and constrains the selection; each tap triggers a re-render.
let setupHumans = 2;
let setupBots = 0;
let aiBots = 1;
let setupDifficulty: Difficulty = 'medium';
let seatCapacity = 6;

/** Highlight the selected button in a row (matched by a data-attribute value). */
function markSelected(container: HTMLElement, attr: string, value: string): void {
  container.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    btn.classList.toggle('count-btn--selected', btn.dataset[attr] === value);
  });
}

export interface PanelHandlers {
  /** Step back in the track editor. */
  onBack: () => void;
  /** Confirm the edges (adjust phase) and move on to start/finish placement. */
  onNext: () => void;
  onConfirmMove: () => void;
  /** "Rematch" — replay the same lineup on the same track in one tap (skipping
   *  the mode-selection wizard). Locally this uses the saved lineup; online
   *  (host) it replays the same room. Only shown when a rematch is available
   *  (canRematch). */
  onChooseSameTrack: () => void;
  /** "Same track, different mode" — keep the track, but go through mode/player
   *  selection again, skipping drawing. */
  onSameTrackNewMode: () => void;
  /** Whether a one-tap rematch is available (local lineup, or online host on the results screen). */
  canRematch: () => boolean;
  /** Whether an online session is currently active (the results dialog adjusts its buttons accordingly). */
  isOnline: () => boolean;
  onNewTrack: () => void;
  /** Back from the player-selection step. */
  onPlayersBack: () => void;
  /** Start a local race: humans human players + bots bots at the given
   *  difficulty (bots take the trailing seats). Shared handler for hotseat and
   *  "Vs. computer". */
  onStartLocal: (humans: number, bots: number, difficulty: Difficulty) => void;
  /** Open the race-rules settings (⚙ button on the setup screen). */
  onOpenSettings: () => void;
  /** Open the race-rules settings from the lobby (⚙ button, host only). */
  onLobbySettings: () => void;
  /** Mode-selection step: local game. */
  onModeLocal: () => void;
  /** Mode-selection step: online (opens the name dialog → creates a race). */
  onModeOnline: () => void;
  /** Mode-selection step: vs. computer (moves to bot-count setup). */
  onModeAI: () => void;
  /** Back from the "Vs. computer" step. */
  onAiBack: () => void;
  /** Back from the mode-selection step. */
  onModeBack: () => void;
  /** Open the join-by-code dialog (from the drawing screen). */
  onJoinByCode: () => void;
  /** Host starts the online race. */
  onLobbyStart: () => void;
  /** Share the race link. */
  onLobbyShare: () => void;
  /** Copy the race code. */
  onLobbyCopyCode: () => void;
  /** Host: add one more bot to an open lobby seat. */
  onLobbyBotAdd: () => void;
  /** Host: remove one bot. */
  onLobbyBotRemove: () => void;
  /** Host: difficulty of the bots being added. */
  onLobbyBotDifficulty: (d: Difficulty) => void;
  /** Leave the lobby. */
  onLobbyLeave: () => void;
  /** Skip the turn of a player who's stalling (their car coasts on its momentum). */
  onSkip: () => void;
  /** Tap on the race-code chip above the map — share the race link. */
  onRaceShare: () => void;
  /** Retire the current player (button on their card) — they drop out of the race. */
  onRetire: () => void;
}

/** State of sending a move online: idle / sending / send failed. */
export type SendState = 'idle' | 'sending' | 'failed';

// ── Confirm-move button: a single render driven by four inputs ─────────────────────
// Its appearance (text/disabled/hidden) depends on send state (setMoveSendState),
// candidate selection (showConfirmMove), and, online, also on whether it's my
// turn and how much time is left (setTurnCountdown). These inputs come from
// different modules, so we keep them in the panel's own state and assemble the
// button in one place — refreshConfirmBtn().
let sendState: SendState = 'idle';
let confirmSelected = false; // a candidate is selected (touch aiming) — can be committed
let confirmAnchorTop = false; // the button has been moved to the top half of the field
let confirmMyTurn = false; // online: it's my turn right now (keep the button visible under the timer)
let confirmCountdownMs: number | null = null; // time left for my turn (shown as a label)

// Base text (without the timer suffix) of the online race's status line — the
// ticking setTurnCountdown decorates it, so we don't depend on the next full
// updatePanel and don't stack up suffixes. null means not an online race (no suffix applied).
let raceStatusBase: string | null = null;

// Waiting on SOMEONE ELSE's online turn: render the status with an animated
// ellipsis (see applyWaitingStatus), so a non-interactive board reads as
// "waiting" rather than "frozen" (m1). Only for a pure waiting state — not for
// skippable/my-turn states, which have their own UI.
let raceWaiting = false;

/**
 * Render the "waiting for someone else's turn" status: base text (with any
 * trailing "…" stripped) + an animated ellipsis + an optional "· m:ss" timer
 * suffix. Built via DOM rather than textContent because the ellipsis is
 * CSS-animated (three dot spans with staggered opacity); both update() and the
 * ticking setTurnCountdown call this same helper so the tick doesn't wipe out
 * the animation. */
function applyWaitingStatus(base: string, msLeft: number | null): void {
  const stripped = base.replace(/…$/, '');
  const dots = document.createElement('span');
  dots.className = 'waiting-dots';
  // Three separate dots: `content` can't be animated, so we fade each one's opacity instead (see status.css).
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span');
    dot.className = 'waiting-dots__dot';
    dot.textContent = '.';
    dots.append(dot);
  }
  const nodes: (Node | string)[] = [stripped, dots];
  if (msLeft !== null) nodes.push(` · ${msToClock(msLeft)}`);
  statusEl.replaceChildren(...nodes);
}

/** Whether the online backend is configured: without it, "Join by code" is always hidden. */
let onlineEnabled = false;

/** Build the confirm-move button's appearance from the panel's current state. */
function refreshConfirmBtn(): void {
  const timer = confirmCountdownMs !== null ? msToClock(confirmCountdownMs) : null;
  // Timer-only button: it's my turn but no target chosen yet — an unclickable placeholder showing the countdown.
  const timerOnly =
    confirmMyTurn && !confirmSelected && sendState !== 'failed' && !!timer;
  confirmMoveBtn.classList.toggle('confirm-move--top', confirmAnchorTop);
  // Timer-only mode isn't clickable and lets clicks pass through to the field (otherwise it would cover a candidate).
  confirmMoveBtn.classList.toggle('confirm-move--timer', timerOnly);
  // Visible when there's something to confirm / a send is in progress (or failed) / it's my online turn.
  confirmMoveBtn.hidden = !(confirmSelected || sendState !== 'idle' || confirmMyTurn);
  confirmMoveBtn.disabled = sendState === 'sending' || timerOnly;
  confirmMoveBtn.textContent =
    sendState === 'sending'
      ? strings.online.sending
      : sendState === 'failed'
        ? strings.online.retrySend
        : timerOnly
          ? `⏱ ${timer}`
          : confirmSelected && timer
            ? `${strings.buttons.confirmMove} · ${timer}`
            : strings.buttons.confirmMove;
}

/**
 * Reflect the move's send state on the confirm button: "Sending…" (disabled,
 * to avoid sending duplicates) / "↻ Retry send" after a failure / the normal
 * "Go!". While a send is in progress or after a failure, the button stays
 * visible even on desktop (where it's normally hidden), so the player can see
 * progress and retry. */
export function setMoveSendState(s: SendState): void {
  sendState = s;
  refreshConfirmBtn();
}

/** Show/hide the floating confirm-move button (touch aiming). While sending
 *  or after a failure, we don't hide it — it shows progress/retry.
 *  `anchor` moves the button to the half of the field free of candidates, so
 *  it doesn't cover target points (otherwise a tap on a target would hit the button). */
export function showConfirmMove(
  show: boolean,
  anchor: 'top' | 'bottom' = 'bottom',
): void {
  confirmSelected = show;
  confirmAnchorTop = anchor === 'top';
  refreshConfirmBtn();
}

/**
 * Online per-turn countdown. My turn → the timer lives on the confirm button
 * (kept visible at all times, even before a target is chosen). Someone else's
 * turn → append "· m:ss" to the status line. `null` means no turn/race:
 * clear the timer and restore the base status. This function isn't involved
 * in the local (non-online) flow — it's never called there. */
export function setTurnCountdown(msLeft: number | null, mine = false): void {
  confirmMyTurn = mine && msLeft !== null;
  confirmCountdownMs = mine ? msLeft : null;
  if (raceStatusBase !== null) {
    // My own timer lives on the button, so the status ("Your turn…") is left
    // alone; someone else's timer gets appended as a suffix to the status.
    if (raceWaiting) {
      // Waiting on someone else's turn: DOM status with an animated ellipsis + optional timer.
      applyWaitingStatus(raceStatusBase, !mine ? msLeft : null);
    } else {
      statusEl.textContent =
        !mine && msLeft !== null
          ? `${raceStatusBase} · ${msToClock(msLeft)}`
          : raceStatusBase;
    }
  }
  refreshConfirmBtn();
}

/** Hide online entry points if the backend isn't configured (local play only). */
export function setOnlineEnabled(enabled: boolean): void {
  onlineEnabled = enabled;
  modeOnlineBtn.hidden = !enabled;
  joinByCodeBtn.hidden = true; // shown only on the editor's first step (see update)
}

export function bindButtons(h: PanelHandlers): void {
  bindTap(backBtn, h.onBack);
  bindTap(nextBtn, h.onNext);
  bindTap(playersBackBtn, h.onPlayersBack);
  bindTap(confirmMoveBtn, h.onConfirmMove);
  // Hotseat setup screen: humans / bots / difficulty — a tap changes the selection and re-renders.
  humanCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    bindTap(btn, () => {
      setupHumans = Number(btn.dataset.humans);
      renderPlayersSetup();
    });
  });
  playersBotCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    bindTap(btn, () => {
      setupBots = Number(btn.dataset.bots);
      renderPlayersSetup();
    });
  });
  playersDifficulty
    .querySelectorAll<HTMLButtonElement>('[data-difficulty]')
    .forEach((btn) => {
      bindTap(btn, () => {
        setupDifficulty = btn.dataset.difficulty as Difficulty;
        renderPlayersSetup();
      });
    });
  bindTap(playersStartBtn, () => h.onStartLocal(setupHumans, setupBots, setupDifficulty));
  bindTap(settingsBtn, h.onOpenSettings);
  bindTap(modeLocalBtn, h.onModeLocal);
  bindTap(modeOnlineBtn, h.onModeOnline);
  bindTap(modeAiBtn, h.onModeAI);
  // "Vs. computer" screen (single human always): bot count + their difficulty.
  aiBotCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    bindTap(btn, () => {
      aiBots = Number(btn.dataset.bots);
      renderAiSetup();
    });
  });
  aiDifficulty.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((btn) => {
    bindTap(btn, () => {
      setupDifficulty = btn.dataset.difficulty as Difficulty;
      renderAiSetup();
    });
  });
  bindTap(aiStartBtn, () => h.onStartLocal(1, aiBots, setupDifficulty));
  bindTap(aiSettingsBtn, h.onOpenSettings);
  bindTap(aiBackBtn, h.onAiBack);
  bindTap(modeBackBtn, h.onModeBack);
  bindTap(joinByCodeBtn, h.onJoinByCode);
  bindTap(skipBtn, h.onSkip);
  bindTap(raceCodeBtn, h.onRaceShare);
  // "Retire" — a confirmation dialog first, then the actual retirement.
  bindTap(retireBtn, () =>
    openConfirm(
      strings.race.retireConfirmTitle,
      strings.race.retireConfirmYes,
      h.onRetire,
    ),
  );
  bindTap(helpBtn, () => openSheet(rulesSheet));
  bindTap(newRaceBtn, () => {
    // Show "Rematch" only when there's something to replay: a local lineup, or,
    // online, the host on the results screen (canRematch covers both cases).
    dlgSameTrack.hidden = !h.canRematch();
    // "Same track, different mode" leads into the local wizard (goToMode) —
    // in a live online session that would desync the game, so we hide it
    // online. That leaves "Rematch" (host) and "Draw a new track" (which, for
    // online, means leaving the session).
    dlgSameTrackNewMode.hidden = h.isOnline();
    openSheet(raceDialog);
  });
  bindTap(dlgSameTrack, () => {
    closeOverlay();
    h.onChooseSameTrack();
  });
  bindTap(dlgSameTrackNewMode, () => {
    closeOverlay();
    h.onSameTrackNewMode();
  });
  bindTap(dlgNewTrack, () => {
    closeOverlay();
    h.onNewTrack();
  });
  bindDialogs();
  bindSettings();
  bindLobby(h);
  bindOverlayClose();
}

/** Icon stat for a player card (speed / crashes / pit stops). */
function stat(text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}

/** Speed stat: a number plus a separate "km/h" unit span, which CSS hides on
 *  narrow cards to free up space for the player's name. */
function speedStat(kmh: number): HTMLSpanElement {
  const s = stat(strings.race.speed(kmh));
  const unit = document.createElement('span');
  unit.className = 'player-card__unit';
  unit.textContent = ` ${strings.race.speedUnit}`;
  s.append(unit);
  return s;
}

/**
 * A compact single-line card: a colored dot, name, and icon stats — speed (a
 * single number = the length of the velocity vector), crash count, and, if
 * the player is currently "in the pits" after a crash, their skipped-turn count.
 */
function playerInfo(p: Player, active: boolean, target: HTMLElement): void {
  target.classList.toggle('player-card--active', active);
  // Out of the race (finished or retired) — dim the card.
  target.classList.toggle('player-card--out', p.place !== null || p.retired);
  const dot = document.createElement('span');
  dot.className = 'player-card__dot';
  dot.style.background = p.color;
  const name = document.createElement('b');
  name.className = 'player-card__name';
  name.textContent = p.name;
  const stats = document.createElement('span');
  stats.className = 'player-card__stats';
  if (p.place !== null) {
    // Finished — show the placing instead of a speedometer.
    stats.append(stat(strings.race.place(p.place)));
  } else if (p.retired) {
    stats.append(stat(strings.race.retired));
  } else {
    // Convert the velocity-vector length into notional km/h and round to the
    // nearest ten — like the gradations on a real speedometer.
    const kmh = Math.round((len(p.vel) * KMH_PER_CELL) / 10) * 10;
    stats.append(speedStat(kmh), stat(strings.race.crashes(p.crashes.length)));
    if (p.skipTurns > 0) stats.append(stat(strings.race.pit(p.skipTurns)));
  }
  target.replaceChildren(dot, name, stats);
}

/**
 * Rebuild player cards as direct children of #raceButtons (before the "New
 * race" button) — this way they land in the panel's two-column mobile grid.
 */
function renderPlayerCards(game: GameState, present?: boolean[]): void {
  raceButtons.querySelectorAll('.player-card').forEach((c) => c.remove());
  game.players.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'player-card';
    playerInfo(p, game.phase === 'race' && game.current === i, card);
    // Online, mark players whose tabs are currently offline.
    if (present && present[i] === false) {
      card.classList.add('player-card--offline');
      card.title = strings.online.offline;
    }
    raceButtons.insertBefore(card, newRaceBtn);
  });
}

// Wizard step number for the "step N of 4" badge, keyed by phase. `ready` and
// errors have no badge (the message renders as plain body text). Locale-independent:
// the badge is built from strings.editor.stepBadge rather than parsed out of
// text (there used to be a regex here for that).
const EDIT_STEP: Partial<Record<EditorStep, number>> = {
  center: 1,
  adjust: 2,
  finish: 3,
  direction: 4,
};
const EDIT_STEP_TOTAL = 4;

/** Render the editor's message: a prominent "step N of 4" badge + instruction. */
function renderEditStatus(editor: EditorState): void {
  statusEl.className = 'status';
  if (editor.error) {
    statusEl.classList.add('status--error');
    statusEl.textContent = editor.message;
    return;
  }
  const step = EDIT_STEP[editor.step];
  if (step !== undefined) {
    renderStepStatus(strings.editor.stepBadge(step, EDIT_STEP_TOTAL), editor.message);
  } else {
    statusEl.classList.add('status--step');
    statusEl.replaceChildren(div('status__body', editor.message));
  }
}

/** Subtitle under the winner's name: race still going for others / already over. */
function winnerSubtitle(over: boolean): HTMLElement {
  const s = document.createElement('span');
  s.className = 'winner__subtitle';
  s.textContent = over ? strings.race.raceOver : strings.race.stillRacing;
  return s;
}

/**
 * Show the winner banner: the winner (1st place) is announced as soon as
 * they're determined, even if the race continues for the others — with a
 * "Race still going" subtitle. A tie for 1st place uses the draw string. The
 * special case where everyone retired and nobody finished (winner === null
 * with the race over) uses the allRetired string.
 */
function showWinner(game: GameState): void {
  const over = game.phase === 'over';
  // When everyone retired (no winner) — no trophy, just text.
  winnerBanner.classList.toggle('winner--noresult', game.winner === null);
  if (game.winner === null) {
    winnerWho.textContent = strings.race.allRetired;
  } else if (game.winner === 'draw') {
    winnerWho.replaceChildren(
      document.createTextNode(strings.race.draw),
      winnerSubtitle(over),
    );
  } else {
    const w = game.players[game.winner];
    const name = document.createElement('span');
    name.style.color = w.color;
    name.textContent = w.name;
    winnerWho.replaceChildren(
      strings.race.winnerFlag,
      document.createElement('br'),
      name,
      winnerSubtitle(over),
    );
  }
  winnerBanner.classList.add('winner--shown');
}

/** Online context for the current turn — used for the race status (whose
 *  turn, whether it's mine, whether it can be skipped, who's offline by seat). */
export interface NetTurn {
  yourTurn: boolean;
  /** Show the skip button: the active player is online but hasn't moved past the timeout. */
  canSkip: boolean;
  /** Name of the player whose turn it is (for the skip-related status). */
  currentName: string;
  /** Presence by seat (index = seat); false means that tab is offline. */
  present: boolean[];
  /** Code of the current online race (for the chip above the map — helps a
   *  disconnected player reconnect). */
  code: string;
  /** Whether this client is the track's creator (can trigger a rematch on the results screen). */
  isHost: boolean;
}

/**
 * Hotseat setup screen: apply grid-seat constraints to the "Humans"/"Bots"
 * rows, highlight the current selection, show the difficulty row when bots ≥
 * 1, and allow starting once there are at least MIN_PLAYERS participants and
 * they all fit on the starting grid (seatCapacity). Humans have a floor of
 * MIN_PLAYERS: a race with a single human is the "Vs. computer" mode (see
 * renderAiSetup), not hotseat, so the "Humans" row starts at 2.
 */
function renderPlayersSetup(): void {
  // Clamp the selection to capacity: humans from MIN_PLAYERS up to the grid size, bots fill the remainder.
  setupHumans = Math.max(MIN_PLAYERS, Math.min(setupHumans, seatCapacity));
  setupBots = Math.max(0, Math.min(setupBots, seatCapacity - setupHumans));
  humanCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    btn.disabled = Number(btn.dataset.humans) > seatCapacity;
  });
  playersBotCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    btn.disabled = setupHumans + Number(btn.dataset.bots) > seatCapacity;
  });
  markSelected(humanCount, 'humans', String(setupHumans));
  markSelected(playersBotCount, 'bots', String(setupBots));
  playersDifficulty.hidden = setupBots === 0;
  markSelected(playersDifficulty, 'difficulty', setupDifficulty);
  const total = setupHumans + setupBots;
  playersStartBtn.disabled = total < MIN_PLAYERS || total > seatCapacity;
}

/**
 * "Vs. computer" screen: one human, bot count 1..(grid size − 1), the
 * difficulty row is always visible. Start is enabled once the grid fits the
 * human plus at least one bot.
 */
function renderAiSetup(): void {
  aiBots = Math.max(1, Math.min(aiBots, Math.max(1, seatCapacity - 1)));
  aiBotCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    btn.disabled = 1 + Number(btn.dataset.bots) > seatCapacity;
  });
  markSelected(aiBotCount, 'bots', String(aiBots));
  markSelected(aiDifficulty, 'difficulty', setupDifficulty);
  aiStartBtn.disabled = seatCapacity < MIN_PLAYERS;
}

/** Context for re-rendering the panel. A single object instead of a pile of
 *  positional parameters: at the call site it's clear which flag means what
 *  (the old form was `updatePanel(m, e, g, 6, net, true, true)`). Splitting
 *  the body up by screen is left for the redesign (see INTERNAL_roadmap). */
export interface PanelCtx {
  phase: Phase;
  editor: EditorState;
  game: GameState | null;
  /** Max seats (from the track's start-point count). Defaults to 6. */
  playersMax?: number;
  /** Online context for the current turn. null means a local game. */
  net?: NetTurn | null;
  /** A bot is moving right now (local game) — don't show the "tap a point" hint. */
  aiTurn?: boolean;
  /** Show "Retire" in the header (the local player is still in the race). */
  canRetire?: boolean;
}

export function updatePanel(ctx: PanelCtx): void {
  const {
    phase,
    editor,
    game,
    playersMax = 6,
    net = null,
    aiTurn = false,
    canRetire = false,
  } = ctx;
  seatCapacity = playersMax;
  editButtons.hidden = phase !== 'edit';
  modeButtons.hidden = phase !== 'modeSelect';
  aiButtons.hidden = phase !== 'ai';
  lobbyButtons.hidden = phase !== 'lobby';
  playersButtons.hidden = phase !== 'players';
  raceButtons.hidden = phase !== 'race';
  skipBtn.hidden = true; // shown below only during a race, when skipping is available
  retireBtn.hidden = !canRetire; // "Retire" in the header — only while the local player is still racing

  // Race-code chip above the map: only during an active online race (net !=
  // null), so a disconnected player can be given the code/link. Hidden on the
  // winner screen and in local games.
  const showCode = phase === 'race' && !!net && !!game && game.phase !== 'over';
  raceCodeBtn.hidden = !showCode;
  if (showCode) raceCodeBtn.textContent = `🔗 ${net!.code}`;

  if (phase === 'edit') {
    renderEditStatus(editor);
    backBtn.disabled = !canStepBack(editor);
    // On step 2, "← Back" erases the whole drawn track — name the action honestly.
    backBtn.textContent =
      editor.step === 'adjust' ? strings.buttons.redraw : strings.buttons.back;
    nextBtn.hidden = editor.step !== 'adjust';
    // "Join by code" only makes sense on the first step; later in the wizard it's just in the way.
    joinByCodeBtn.hidden = !onlineEnabled || editor.step !== 'center';
    return;
  }

  if (phase === 'modeSelect') {
    renderStepStatus(strings.modeSelect.promptBadge, strings.modeSelect.prompt);
    return;
  }

  if (phase === 'ai') {
    renderStepStatus(strings.aiSelect.promptBadge, strings.aiSelect.prompt);
    renderAiSetup();
    return;
  }

  if (phase === 'lobby') {
    // Lobby content (code, roster, status) is rendered by renderLobby().
    return;
  }

  if (phase === 'players') {
    renderStepStatus(strings.players.promptBadge, strings.players.prompt);
    renderPlayersSetup();
    return;
  }

  statusEl.className = 'status';
  raceStatusBase = null; // by default don't decorate the status with a timer (set in the net branch)
  raceWaiting = false; // the animated ellipsis is only armed for the pure "someone else's turn" case
  if (!game) return;

  const cur = game.players[game.current];
  renderPlayerCards(game, net?.present);

  // The winner is announced right away (winner !== null), even while the race
  // continues for others; the final banner shows once the race is fully over.
  if (game.winner !== null || game.phase === 'over') {
    showWinner(game);
  } else {
    winnerBanner.classList.remove('winner--shown');
  }

  if (game.phase === 'over') {
    // On the results screen, tell a guest in an online race that the track's
    // creator triggers the rematch (the guest has no rematch button — they
    // get dropped into the new race via onGameState).
    statusEl.textContent = net && !net.isHost ? strings.online.rematchWaiting : '';
    return;
  }

  if (net) {
    if (net.canSkip) {
      raceStatusBase = strings.online.skippable(net.currentName);
      statusEl.textContent = raceStatusBase;
      const name = document.createElement('b');
      name.className = 'skip-btn__name';
      name.style.color = cur.color;
      name.textContent = cur.name;
      skipBtn.replaceChildren(
        document.createTextNode(`${strings.online.skipTurnBtn} `),
        name,
      );
      skipBtn.hidden = false;
    } else if (net.yourTurn && sendState === 'failed') {
      // The move didn't reach the server — keep a prominent error message until the player retries.
      statusEl.classList.add('status--error');
      statusEl.textContent = strings.online.sendFailed;
    } else if (net.yourTurn) {
      // My turn: the timer lives on the confirm button, so we don't decorate the status.
      statusEl.textContent = strings.online.yourTurn;
    } else {
      // Someone else's turn: remember the base text — the ticking countdown
      // will append "· m:ss" to it. The ellipsis is animated so a
      // non-interactive board reads as "waiting" (m1).
      raceStatusBase = strings.online.turnOf(cur.name);
      raceWaiting = true;
      applyWaitingStatus(raceStatusBase, null);
    }
    return;
  }
  const warn = game.finalTurnsLeft !== null ? strings.race.finalWarn : '';
  if (aiTurn) {
    // A bot is moving: the "tap a point" hint doesn't apply — the human just waits.
    statusEl.textContent = `${strings.race.driver(cur.name)}${warn}`;
    return;
  }
  const hint = coarsePointer ? strings.race.hintTouch : strings.race.hintMouse;
  statusEl.textContent = `${strings.race.driver(cur.name)} ${hint}${warn}`;
}
