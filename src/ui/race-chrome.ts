// Full-bleed race chrome (Blueprint redesign): everything that floats over the
// board while a race is running. Built here (its owner module) and mounted into
// .app__board on first show, like the editor's and the setup screens' chrome.
//
// This is a merge, not just a re-skin. Three widgets used to answer "who is
// racing and whose turn is it" in three places — the standings strip above the
// map, the turn-queue dot strip next to it, and a grid of player cards down in
// the side panel — and the hi-fi folds all three into one classification card:
// an UP NEXT strip (+ room code on its label line) and one row per car. The
// row's right slot carries whatever that car's state calls for (placing /
// retired / stalled / pit penalty / speed + crashes), so there's a single place
// to read a racer.
//
// The confirm-move button and the skip button are built here too, in the action
// zone, along with the four inputs that decide how the confirm button looks.

import { Phase } from '../app-state';
import { GameState } from '../model/game';
import { NavField } from '../model/nav';
import { upcomingSlots } from '../model/turns';
import { strings } from '../i18n';
import { msToClock } from './format';
import { renderRows, resetStandings } from './classification';
import { bindTap } from './dom';
import { el, button, icon, buildBrand, buildStatus, StatusBanner } from './pr-chrome';
import { openMenu } from './menu';
import {
  BURGER_SVG,
  CHECK_SVG,
  COPY_SVG,
  REMATCH_SVG,
  SHARE_SVG,
  SKIP_SVG,
} from './icons';

/** How many upcoming turns the UP NEXT strip shows, including the current one. */
const QUEUE_LEN = 9;

const board = document.querySelector('.app__board')!;

let root: HTMLElement;
let codeBtn: HTMLButtonElement;
let codeText: HTMLElement;
let nextEl: HTMLElement;
let dotsEl: HTMLElement;
let rowsEl: HTMLElement;
let actEl: HTMLElement;
let chipEl: HTMLElement;
let chipDot: HTMLElement;
let chipText: HTMLElement;
let confirmBtn: HTMLButtonElement;
let confirmCheckEl: HTMLElement;
let confirmRetryEl: HTMLElement;
let confirmTextEl: HTMLElement;
let skipBtn: HTMLButtonElement;
let skipTextEl: HTMLElement;
let connEl: HTMLElement;
let connStatus: StatusBanner;
let connCodeBtn: HTMLButtonElement;
let connCodeText: HTMLElement;
let built = false;

/** Tap on the room code in the card header — share the race link. */
let onShare: () => void = () => {};
/** Tap the code on the reconnect banner — copy it, so the race can be rejoined. */
let onCopy: () => void = () => {};

function build(h: RaceChromeHandlers): void {
  root = el('div', 'pr-layer pr-race');
  root.hidden = true;

  // ── Top: burger + the classification card ──────────────────────────────────
  // On a phone the burger floats beside the card; from 700px the pair becomes a
  // rail, and the brand joins the burger on its top row — the same header the
  // wizard rail carries, so the run-up and the race read as one screen.
  const top = el('div', 'pr-race__top', root);
  const bar = el('div', 'pr-race__bar', top);
  buildBrand(bar, { cls: 'pr-brand--sm pr-race__brand', dashes: 6 });
  const burger = button('pr-btn pr-btn--icon pr-race__burger', bar);
  burger.setAttribute('aria-label', strings.menu.title);
  icon('pr-btn__ico', BURGER_SVG, burger);
  burger.addEventListener('click', openMenu);

  // The card used to open with a "Classification" heading; it said nothing the
  // list of placings below doesn't say by itself, so the queue strip is the
  // card's first row now and the room code moved down into its label line.
  const card = el('div', 'pr-card pr-race__card', top);
  nextEl = el('div', 'pr-race__next', card);
  const nextHead = el('div', 'pr-race__nexthead', nextEl);
  el('span', 'pr-race__nextlabel', nextHead).textContent = strings.race.upNext;
  // A share glyph, not the lobby's copy one: this button opens the share sheet
  // (onShare) rather than copying — the reconnect banner below is the one that
  // copies, and the two must not promise the same thing.
  codeBtn = button('pr-race__code', nextHead);
  codeText = el('span', 'pr-race__code-text', codeBtn);
  icon('pr-race__code-ico', SHARE_SVG, codeBtn);
  codeBtn.addEventListener('click', () => onShare());
  dotsEl = el('div', 'pr-race__dots', nextEl);
  dotsEl.setAttribute('role', 'img');
  dotsEl.setAttribute('aria-label', strings.race.queueLabel);

  rowsEl = el('div', 'pr-race__rows', card);
  rowsEl.setAttribute('role', 'img');
  rowsEl.setAttribute('aria-label', strings.race.standingsLabel);

  // ── Action zone: status chip over the confirm / skip buttons ───────────────
  actEl = el('div', 'pr-race__act', root);

  // Realtime dropped (hi-fi 5E): the persistent banner takes over the action
  // zone, with the room code under it — being handed the code is the one useful
  // thing while the board is frozen, and a reload can rejoin with it. The banner
  // is buildStatus(), the same spinner-and-line component the guest lobby waits
  // on; the global #connBanner stays out of the way (see race-chrome.css).
  connEl = el('div', 'pr-race__conn', actEl);
  connEl.hidden = true;
  connStatus = buildStatus(connEl);
  connStatus.set(strings.online.reconnecting, true);
  connCodeBtn = button('pr-race__conncode', connEl);
  connCodeText = el('span', 'pr-race__conncode-text', connCodeBtn);
  icon('pr-race__conncode-ico', COPY_SVG, connCodeBtn);
  connCodeBtn.addEventListener('click', () => onCopy());

  chipEl = el('div', 'pr-card pr-race__chip', actEl);
  chipDot = el('span', 'pr-race__chipdot', chipEl);
  chipText = el('span', 'pr-race__chiptext', chipEl);

  // Skip a stalling player's turn (online only): renderSkip sets the text —
  // online.skipTurnBtn plus the stuck player's name, in their colour.
  skipBtn = button('pr-btn pr-btn--caps pr-race__skip', actEl);
  skipBtn.hidden = true;
  icon('pr-race__skip-ico', SKIP_SVG, skipBtn);
  skipTextEl = el('span', 'pr-race__skip-text', skipBtn);
  bindTap(skipBtn, h.onSkip);

  confirmBtn = button('pr-btn pr-btn--primary pr-btn--caps pr-race__confirm', actEl);
  confirmBtn.hidden = true;
  // Four states share this button (see refreshConfirmBtn), and only two carry an
  // icon — so both live here permanently and the render picks which, if any, is
  // shown. Rebuilding them per state would restyle the button mid-race.
  confirmCheckEl = icon('pr-btn__ico pr-race__confirm-ico', CHECK_SVG, confirmBtn);
  confirmRetryEl = icon('pr-btn__ico pr-race__confirm-ico', REMATCH_SVG, confirmBtn);
  confirmTextEl = el('span', 'pr-race__confirm-text', confirmBtn);
  bindTap(confirmBtn, h.onConfirmMove);

  board.append(root);
  built = true;
}

export interface RaceChromeHandlers {
  /** Tap on the room code in the card header — share the race link. */
  onShare: () => void;
  /** Tap the code on the reconnect banner — copy it, so the race can be rejoined. */
  onCopy: () => void;
  /** Commit the selected move ("Go!"). */
  onConfirmMove: () => void;
  /** Skip the turn of a player who's stalling (their car coasts on its momentum). */
  onSkip: () => void;
}

export function initRaceChrome(h: RaceChromeHandlers): void {
  onShare = h.onShare;
  onCopy = h.onCopy;
  build(h);
}

/**
 * The bottom action stack, for another module to dock a control into.
 *
 * Only race-result uses it: a player who has retired or finished while the
 * others drive on gets their three ways out here rather than under a
 * full-screen layer, and the bottom of the board is already this stack's job —
 * safe-area insets, the desktop grid column and the zoom controls' clearance
 * are all solved here and would only be re-derived, badly, by a second bar.
 */
export function raceActionSlot(): HTMLElement {
  return actEl;
}

// ── Confirm-move button: a single render driven by four inputs ───────────────
// Its appearance (text/disabled/hidden) depends on the send state
// (setMoveSendState), candidate selection (showConfirmMove), and, online, also
// on whether it's my turn and how much time is left (setTurnCountdown). Those
// inputs come from different modules, so we keep them here and assemble the
// button in one place — refreshConfirmBtn().

/** State of sending a move online: idle / sending / send failed. */
export type SendState = 'idle' | 'sending' | 'failed';

let sendState: SendState = 'idle';
let confirmSelected = false; // a candidate is selected (touch aiming) — can be committed
let confirmMyTurn = false; // online: it's my turn right now (keep the button visible under the timer)
let confirmCountdownMs: number | null = null; // time left for my turn (shown as a label)

// Base text (without the timer suffix) of the online race's status chip — the
// ticking setTurnCountdown decorates it, so we don't depend on the next full
// render and don't stack up suffixes. null means not an online race.
let chipBase: string | null = null;

// Waiting on SOMEONE ELSE's online turn: render the chip with an animated
// ellipsis (see applyWaitingChip), so a non-interactive board reads as
// "waiting" rather than "frozen" (m1). Only for a pure waiting state — not for
// skippable/my-turn states, which have their own UI.
let chipWaiting = false;

// Local game, bots on the clock: the chip already holds the stable "rivals are
// moving" line. Bot turns re-render the chrome several times a second, and
// rebuilding the same line would restart the ellipsis animation on every one of
// them — so we only touch the DOM when entering the state.
let chipAiWaiting = false;

/** Build the confirm-move button's appearance from the current state. */
function refreshConfirmBtn(): void {
  if (!built) return;
  const timer = confirmCountdownMs !== null ? msToClock(confirmCountdownMs) : null;
  // Timer-only button: it's my turn but no target chosen yet — an unclickable placeholder showing the countdown.
  const timerOnly =
    confirmMyTurn && !confirmSelected && sendState !== 'failed' && !!timer;
  // Timer-only mode isn't clickable and lets clicks pass through to the field (otherwise it would cover a candidate).
  confirmBtn.classList.toggle('pr-race__confirm--timer', timerOnly);
  // A failed send turns the whole action zone red (the retry is the only way on).
  actEl.classList.toggle('pr-race__act--error', sendState === 'failed');
  // Visible when there's something to confirm / a send is in progress (or failed) / it's my online turn.
  confirmBtn.hidden = !(confirmSelected || sendState !== 'idle' || confirmMyTurn);
  confirmBtn.disabled = sendState === 'sending' || timerOnly;
  confirmTextEl.textContent =
    sendState === 'sending'
      ? strings.online.sending
      : sendState === 'failed'
        ? strings.online.retrySend
        : timerOnly
          ? timer
          : confirmSelected && timer
            ? `${strings.buttons.confirmMove} · ${timer}`
            : strings.buttons.confirmMove;
  // The tick belongs to "Go!" alone. A send in progress and the bare countdown
  // are states to read, not act on; a failed send offers the circular arrow
  // instead, since the button now means "try again".
  confirmRetryEl.hidden = sendState !== 'failed';
  confirmCheckEl.hidden = sendState !== 'idle' || timerOnly;
}

/**
 * Reflect the move's send state on the confirm button: "Sending…" (disabled, to
 * avoid sending duplicates) / "Send again" after a failure / the normal "Go!".
 * While a send is in progress or after a failure, the button stays visible even
 * when nothing is selected, so the player can see progress and retry.
 */
export function setMoveSendState(s: SendState): void {
  sendState = s;
  refreshConfirmBtn();
}

/**
 * Show/hide the floating confirm-move button. While sending or after a failure,
 * we don't hide it — it shows progress/retry. `anchor` moves the action zone to
 * the half of the field free of candidates, so it doesn't cover target points
 * (otherwise a tap on a target would hit the button).
 */
export function showConfirmMove(
  show: boolean,
  anchor: 'top' | 'bottom' = 'bottom',
): void {
  confirmSelected = show;
  if (built) root.classList.toggle('pr-race--act-top', anchor === 'top');
  refreshConfirmBtn();
}

/**
 * Render the "waiting for someone else's turn" chip: base text (with any
 * trailing "…" stripped) + an animated ellipsis + an optional "· m:ss" suffix.
 * Built via DOM rather than textContent because the ellipsis is CSS-animated
 * (three dot spans with staggered opacity); both the full render and the
 * ticking setTurnCountdown call this helper, so the tick doesn't wipe out the
 * animation.
 */
function applyWaitingChip(base: string, msLeft: number | null): void {
  const dots = el('span', 'pr-dots');
  // Three separate dots: `content` can't be animated, so we fade each one's opacity instead.
  for (let i = 0; i < 3; i++) {
    el('span', 'pr-dots__dot', dots).textContent = '.';
  }
  const nodes: (Node | string)[] = [base.replace(/…$/, ''), dots];
  if (msLeft !== null) nodes.push(` · ${msToClock(msLeft)}`);
  chipText.replaceChildren(...nodes);
}

/**
 * Online per-turn countdown. My turn → the timer lives on the confirm button
 * (kept visible at all times, even before a target is chosen). Someone else's
 * turn → append "· m:ss" to the status chip. `null` means no turn/race: clear
 * the timer and restore the base text. Never called in a local game.
 */
export function setTurnCountdown(msLeft: number | null, mine = false): void {
  confirmMyTurn = mine && msLeft !== null;
  confirmCountdownMs = mine ? msLeft : null;
  if (built && chipBase !== null) {
    // My own timer lives on the button, so the chip ("Your turn") is left
    // alone; someone else's timer gets appended to the chip.
    if (chipWaiting) {
      applyWaitingChip(chipBase, !mine ? msLeft : null);
    } else {
      chipText.textContent =
        !mine && msLeft !== null ? `${chipBase} · ${msToClock(msLeft)}` : chipBase;
    }
  }
  refreshConfirmBtn();
}

/** The UP NEXT strip: who's moving now (first, outlined) and who follows. */
function renderQueue(game: GameState): void {
  // ignoreRoundCap: the strip keeps a constant length — see upcomingSlots.
  const slots = upcomingSlots(game, QUEUE_LEN, { ignoreRoundCap: true });
  const children: HTMLElement[] = [];
  let prevRound: number | null = null;
  slots.forEach((slot, i) => {
    // Lap change — a separator before the dot (except the very first one). With
    // two players the starting-player shift can put the same colour on both
    // sides of a boundary (…○│○…); the separator says "new lap", not "moved twice".
    if (prevRound !== null && slot.round !== prevRound) {
      children.push(el('span', 'pr-race__sep'));
    }
    prevRound = slot.round;
    const dot = el(
      'span',
      i === 0 ? 'pr-race__dot pr-race__dot--current' : 'pr-race__dot',
    );
    dot.style.background = game.players[slot.seat].color;
    children.push(dot);
  });
  dotsEl.replaceChildren(...children);
}

/** Online context for the current turn — the same object the panel used. */
export interface NetTurn {
  yourTurn: boolean;
  /** Show the skip button: the active player is online but hasn't moved past the timeout. */
  canSkip: boolean;
  /** Name of the player whose turn it is (for the skip-related status). */
  currentName: string;
  /** Presence by seat (index = seat); false means that tab is offline. */
  present: boolean[];
  /** Code of the current online race — the chip lets a disconnected player back in. */
  code: string;
  /** Whether this client is the track's creator (can trigger a rematch). */
  isHost: boolean;
}

export interface RaceCtx {
  phase: Phase;
  game: GameState | null;
  /** Navigation field of the current track — the standings order needs it. */
  nav: NavField | null;
  /** Online context for the current turn. null means a local game. */
  net?: NetTurn | null;
  /** A bot is moving right now (local game) — don't show the "tap a point" hint. */
  aiTurn?: boolean;
  /** This client's own seat, or −1. Drives the amber "you are up" row. */
  mySeat: number;
  /** The lone human racing bots, or −1 — the seat we address as "you". */
  soloSeat?: number;
  /** Realtime channel is up. Only meaningful online; a local race is never "lost". */
  connected?: boolean;
}

/** The status chip: a dot in the current car's colour plus a line of text. */
function setChip(text: string, color: string | null, error = false): void {
  chipEl.classList.toggle('pr-race__chip--error', error);
  chipDot.hidden = !color;
  if (color) chipDot.style.background = color;
  chipText.textContent = text;
}

/**
 * Render the race chrome for the current state. Shows the chrome (and hides the
 * side panel, via body.is-racing) only while a race is on screen.
 */
export function renderRaceChrome(ctx: RaceCtx): void {
  if (!built) return;
  const {
    phase,
    game,
    nav,
    net = null,
    aiTurn = false,
    mySeat,
    soloSeat = -1,
    connected = true,
  } = ctx;
  // Only the LIVE race, not the results screen: the designed result layer is the
  // next step, and until it lands the old panel still owns `over` (winner banner
  // + "New race"). That's the seam — when the layer arrives, drop `game.phase`
  // from this condition and the panel's race branch goes with it.
  const racing = phase === 'race' && !!game && !!nav && game.phase === 'race';
  root.hidden = !racing;
  document.body.classList.toggle('is-racing', racing);
  if (!racing) {
    resetStandings(); // leaving the race — a new one recomputes from scratch
    chipBase = null;
    chipWaiting = false;
    chipAiWaiting = false;
    return;
  }

  // Room code: online only, so a disconnected player can be handed the link.
  codeBtn.hidden = !net;
  if (net) codeText.textContent = net.code;

  renderQueue(game!);

  renderRows(rowsEl, game!, nav!, {
    mySeat,
    soloSeat,
    stalledSeat: net?.canSkip ? game!.current : -1,
    present: net?.present,
  });

  renderSkip(game!, net);
  renderChip(game!, net, aiTurn, soloSeat);

  // Realtime is down: the banner replaces the status chip rather than stacking
  // with it — the chip would only say whose turn it is, which is exactly the
  // thing we've stopped being able to keep up to date.
  const lost = !!net && !connected;
  connEl.hidden = !lost;
  if (lost) connCodeText.textContent = strings.online.raceCode(net!.code);
  chipEl.hidden = lost;
}

/**
 * "Skip <name>" — offered when the mover is connected but has sat past the turn
 * timer. Their name is appended in their own car colour, so it's obvious you're
 * skipping someone else's turn rather than your own.
 */
function renderSkip(game: GameState, net: NetTurn | null): void {
  skipBtn.hidden = !net?.canSkip;
  if (!net?.canSkip) return;
  const cur = game.players[game.current];
  const name = el('b', 'pr-race__skipname');
  name.style.color = cur.color;
  name.textContent = cur.name;
  skipTextEl.replaceChildren(
    document.createTextNode(`${strings.online.skipTurnBtn} `),
    name,
  );
}

/** The one line of text under the board: whose turn it is and what to do. */
function renderChip(
  game: GameState,
  net: NetTurn | null,
  aiTurn: boolean,
  soloSeat: number,
): void {
  chipBase = null; // by default don't decorate the chip with a timer (set in the net branch)
  chipWaiting = false; // the animated ellipsis is only armed for "someone else's turn"
  const wasAiWaiting = chipAiWaiting; // every branch below but the bots' one leaves the state
  chipAiWaiting = false;
  const cur = game.players[game.current];

  if (net) {
    if (net.canSkip) {
      // No countdown suffix here: the turn timer has already run out — that's
      // what put this state on screen — so a suffix could only ever read "0:00".
      setChip(strings.online.skippable(net.currentName), cur.color);
    } else if (net.yourTurn && sendState === 'failed') {
      // The move didn't reach the server — a prominent error until they retry.
      setChip(strings.online.sendFailed, null, true);
    } else if (net.yourTurn) {
      // My turn: the timer lives on the confirm button, so no suffix here.
      setChip(strings.online.yourTurn, cur.color);
    } else {
      // Someone else's turn: remember the base text — the ticking countdown
      // appends "· m:ss". The ellipsis animates so a non-interactive board
      // reads as "waiting" rather than frozen (m1).
      chipBase = strings.online.turnOf(cur.name);
      chipWaiting = true;
      setChip('', cur.color);
      applyWaitingChip(chipBase, null);
    }
    return;
  }

  const warn = game.finalTurnsLeft !== null ? strings.race.finalWarn : '';
  if (aiTurn) {
    // Bots are moving: ONE line for their whole run rather than each bot's name
    // in turn — naming them rewrote the chip several times a second, which is
    // unreadable and useless, since the human has nothing to do until it's their
    // turn again. Same waiting ellipsis as the online branch, and no dot: the
    // line is about the field, not about one car. finalWarn is left off too —
    // it's advice on the human's own driving, and it comes back with the hint.
    if (!wasAiWaiting) {
      setChip('', null);
      applyWaitingChip(strings.race.rivalsMoving, null);
    }
    chipAiWaiting = true;
    return;
  }
  // Racing bots on your own: the mover is always you, so name the turn instead
  // of the car — a colour name tells the only human at the wheel nothing.
  const driver =
    game.current === soloSeat ? strings.race.driverYou : strings.race.driver(cur.name);
  setChip(`${driver} ${strings.race.hintPick}${warn}`, cur.color);
}
