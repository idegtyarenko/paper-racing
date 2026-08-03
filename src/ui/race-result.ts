// The result screen (Blueprint redesign, hi-fi 5H·A/B/C): a full-bleed layer
// that takes over the board once every car has finished or retired.
//
// It replaces two separate things: the old `.winner` banner in the side panel
// and the "New race" sheet you had to open from it. The hi-fi puts the outcome,
// the final classification and the three ways on from here on one screen, so
// nothing about the end of a race is behind a tap any more.
//
// Deliberately NOT shown the moment first place is decided. The race carries on
// for everyone else, and a popup declaring a winner over a live board stops the
// people still driving for second (hi-fi 5G) — until the flag, a finisher is
// just a row in the classification that reads "Finished · 1st".

import { GameState } from '../model/game';
import { NavField } from '../model/nav';
import { strings } from '../i18n';
import { renderRows } from './classification';
import { raceActionSlot } from './race-chrome';
import { el, button, icon, REMATCH_SVG } from './pr-chrome';

/** Laurel cup — you won. */
const TROPHY_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10v4a5 5 0 0 1-10 0zM7 6H4v1.5a3.5 3.5 0 0 0 3.4 3.5M17 6h3v1.5a3.5 3.5 0 0 1-3.4 3.5M9 19h6M8.5 21h7M12 15v4"/></svg>';
/** Podium bars — someone else took it. */
const PODIUM_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="15" width="6" height="6"/><rect x="9" y="10" width="6" height="11"/><rect x="16" y="17" width="6" height="4"/></svg>';
const board = document.querySelector('.app__board')!;

export interface ResultHandlers {
  /** "Rematch" — same lineup, same track, no wizard. */
  onRematch: () => void;
  /** "Same track, new lineup" — keep the track, re-pick mode and players. */
  onSameTrack: () => void;
  /** "Draw a new track" — back to the editor (online: leaves the session). */
  onNewTrack: () => void;
  /** Online guest's exit from the rematch wait — frees the seat, leaves the room running. */
  onGuestLeave: () => void;
}

let root: HTMLElement;
let labelEl: HTMLElement;
let iconEl: HTMLElement;
let headlineEl: HTMLElement;
let subtitleEl: HTMLElement;
let rowsEl: HTMLElement;
let innerEl: HTMLElement;
let dockEl: HTMLElement;
let actionsEl: HTMLElement;
let rematchBtn: HTMLButtonElement;
let sameTrackBtn: HTMLButtonElement;
let newTrackBtn: HTMLButtonElement;
let hostWaitHintEl: HTMLElement;
let guestEl: HTMLElement;
let built = false;

function build(h: ResultHandlers): void {
  root = el('div', 'pr-layer pr-result');
  root.hidden = true;

  // A scrim over the finished board: the track stays legible underneath (it's
  // what everyone just drove) but stops competing with the result.
  el('div', 'pr-result__scrim', root);

  innerEl = el('div', 'pr-result__inner', root);
  const inner = innerEl;

  const head = el('div', 'pr-result__head', inner);
  iconEl = el('span', 'pr-result__icon', head);
  labelEl = el('span', 'pr-result__label', head);
  headlineEl = el('div', 'pr-result__headline', head);
  subtitleEl = el('div', 'pr-result__subtitle', head);

  // Only the full screen has a classification — the dock appears while the race
  // is still being decided, so there is no final one to show.
  const cardEl = el('div', 'pr-card pr-result__card', inner);
  el('span', 'pr-label pr-result__cardhead', cardEl).textContent =
    strings.race.classification;
  rowsEl = el('div', 'pr-race__rows', cardEl);
  rowsEl.setAttribute('role', 'img');
  rowsEl.setAttribute('aria-label', strings.race.standingsLabel);

  // The buttons live in a wrapper, because they have two homes: inside this
  // layer when the race is over, and docked into the live race's bottom stack
  // while the others are still driving (see renderRaceResult). Moving one
  // wrapper keeps that a re-parent rather than a rebuild — the buttons, their
  // listeners and their state are the same either way.
  dockEl = el('div', 'pr-result__dock', inner);
  actionsEl = el('div', 'pr-result__actions', dockEl);
  rematchBtn = button('pr-btn pr-btn--primary pr-btn--caps', actionsEl);
  icon('pr-btn__ico', REMATCH_SVG, rematchBtn);
  el('span', 'pr-result__btntext', rematchBtn).textContent = strings.buttons.sameTrack;
  rematchBtn.addEventListener('click', h.onRematch);
  sameTrackBtn = button('pr-btn pr-btn--caps', actionsEl);
  sameTrackBtn.textContent = strings.buttons.sameTrackNewMode;
  sameTrackBtn.addEventListener('click', h.onSameTrack);
  newTrackBtn = button('pr-btn pr-btn--caps', actionsEl);
  newTrackBtn.textContent = strings.buttons.newTrack;
  newTrackBtn.addEventListener('click', h.onNewTrack);
  // Shown only for a host stuck driving bots for the rest of the room — see
  // hostMustStayForBots in renderRaceResult.
  hostWaitHintEl = el('div', 'pr-result__subtitle', actionsEl);
  hostWaitHintEl.textContent = strings.race.earlyExitHostWait;

  // A guest can't start anything — the track's creator owns the room, and the
  // guest is dropped straight into the new race when they do. So they get a
  // dashed "waiting" plate where the buttons would be, not disabled buttons.
  // Only for the real end-of-race rematch wait — during an early exit the
  // guest isn't waiting on anything, they can still just leave.
  guestEl = el('div', 'pr-result__guest', inner);
  const waitEl = el('div', 'pr-result__wait', guestEl);
  const dots = el('span', 'pr-result__dots', waitEl);
  for (let i = 0; i < 3; i++) el('span', 'pr-result__dot', dots);
  el('span', 'pr-result__waittext', waitEl).textContent = strings.online.rematchWaiting;
  // ...but waiting is not the only thing they can do. Without this the screen is
  // a dead end: no buttons, and a reload just restores the finished race from
  // the snapshot. Leaving frees the seat; the rematch still runs without us.
  const guestLeaveBtn = button('pr-btn pr-btn--caps', guestEl);
  guestLeaveBtn.textContent = strings.online.leaveRace;
  guestLeaveBtn.addEventListener('click', h.onGuestLeave);

  board.append(root);
  built = true;
}

export function initRaceResult(h: ResultHandlers): void {
  build(h);
}

export interface ResultCtx {
  game: GameState | null;
  nav: NavField | null;
  /** True once the race is fully over — every car has a place or has retired. */
  over: boolean;
  /**
   * True once no human has anything left to do, but the race itself hasn't
   * resolved yet (bots may still be racing it out) — same three buttons, shown
   * early so a retired/finished human isn't stuck watching bots finish.
   */
  earlyExit: boolean;
  /** This client's seat, or −1 (hot-seat has no single "you"). */
  mySeat: number;
  /** In an online race and not the host: the rematch isn't ours to start. */
  onlineGuest: boolean;
  /** Whether a one-tap rematch is available at all (a saved lineup, or host online). */
  canRematch: boolean;
  /** Online: "same track, new lineup" runs the local wizard, which would desync the room. */
  isOnline: boolean;
  /**
   * Online host with bots still live in the room: leaving (session.leave())
   * would strand them mid-race for everyone else, since only the host drives
   * bot moves — "Draw a new track" is disabled until the bots are done.
   */
  hostMustStayForBots: boolean;
}

/**
 * Headline block. Three outcomes, and the difference between the first two is
 * whether the winner is you: "You won" in your own colour, or "<name> wins" in
 * theirs. Nobody finishing is neither — no trophy, no colour, just what happened.
 */
function renderHead(game: GameState, mySeat: number): void {
  const { winner } = game;
  iconEl.replaceChildren();
  iconEl.hidden = false;
  headlineEl.style.removeProperty('color');

  if (winner === null) {
    // Everyone retired: no finishers, so there's nothing to celebrate.
    iconEl.hidden = true;
    headlineEl.classList.add('pr-result__headline--quiet');
    headlineEl.textContent = strings.race.allRetired;
    subtitleEl.textContent = strings.race.allRetiredSub;
    return;
  }
  headlineEl.classList.remove('pr-result__headline--quiet');

  if (winner === 'draw') {
    // A dead heat for first — the photo finish couldn't split them.
    icon('pr-result__iconsvg', TROPHY_SVG, iconEl);
    headlineEl.textContent = strings.race.drawTitle;
    subtitleEl.textContent = strings.race.draw;
    return;
  }

  const w = game.players[winner];
  const mine = winner === mySeat;
  icon('pr-result__iconsvg', mine ? TROPHY_SVG : PODIUM_SVG, iconEl);
  headlineEl.style.color = w.color;
  headlineEl.textContent = mine ? strings.race.youWon : strings.race.someoneWon(w.name);
  subtitleEl.textContent = mine ? strings.race.youWonSub : strings.race.someoneWonSub;
}

/**
 * Show the ways on from here, in one of two shapes.
 *
 * `over` — the race is resolved — is the full-screen layer: outcome, final
 * classification, three buttons. A decided winner is not enough while others
 * are still driving (5G).
 *
 * `earlyExit` — this human has retired or finished, but the race hasn't
 * resolved (bots or other players are still driving) — is the same three
 * buttons docked into the live race's bottom stack instead. The board stays
 * visible and drivable-looking so you can watch the rest of the field come
 * home, which is the whole point: finishing first used to blank the race out.
 * There's no headline and no classification down there — the buttons are the
 * only thing this player still has to decide, and a final classification
 * doesn't exist yet.
 *
 * `over` wins if both are somehow true at once (the race resolved while the
 * dock was up), which is also how the dock gives way to the full screen.
 */
export function renderRaceResult(ctx: ResultCtx): void {
  if (!built) return;
  const {
    game,
    nav,
    over,
    earlyExit,
    mySeat,
    onlineGuest,
    canRematch,
    isOnline,
    hostMustStayForBots,
  } = ctx;
  const ready = !!game && !!nav;
  const fullscreen = over && ready;
  const docked = !over && earlyExit && ready;

  root.hidden = !fullscreen;
  // Not for the dock: `is-result` says the layer owns the board, and it takes
  // the zoom controls away with it (race-result.css). The dock leaves the race
  // to be watched, so the board keeps its controls.
  document.body.classList.toggle('is-result', fullscreen);
  // The chip talks to whoever is on the clock — whose turn it is, what to tap.
  // This player has finished driving; the buttons say everything left to say,
  // so the chip steps aside rather than stacking above them (race-chrome.css).
  document.body.classList.toggle('is-early-exit', docked);

  dockEl.hidden = !fullscreen && !docked;
  // Re-parent only on a change of home: this runs on every render, and moving a
  // live node would otherwise churn layout (and restart the button's glow) many
  // times a second while the bots drive.
  const home = docked ? raceActionSlot() : innerEl;
  if (dockEl.parentElement !== home) {
    if (docked) home.append(dockEl);
    else innerEl.insertBefore(dockEl, guestEl);
  }
  dockEl.classList.toggle('pr-result__dock--live', docked);

  if (!fullscreen && !docked) return;

  if (fullscreen) {
    labelEl.textContent = strings.race.raceComplete;
    renderHead(game!, mySeat);
    renderRows(rowsEl, game!, nav!, { mySeat, final: true });
  }

  // A guest waits for the host only for the real end-of-race rematch — during
  // an early exit there's nothing to wait for, they can just leave.
  const guestWaiting = onlineGuest && over;
  actionsEl.hidden = guestWaiting;
  guestEl.hidden = !guestWaiting;
  // Only offer a rematch when there's something to replay (online rematch
  // also requires the room to actually be over — canRematch already covers that).
  rematchBtn.hidden = !canRematch;
  // "Same track, new lineup" walks back into the local wizard, which would
  // desync a live room — online that leaves "Rematch" and "Draw a new track"
  // (which, online, means leaving the session).
  sameTrackBtn.hidden = isOnline;
  newTrackBtn.disabled = hostMustStayForBots;
  hostWaitHintEl.hidden = !hostMustStayForBots;
}
