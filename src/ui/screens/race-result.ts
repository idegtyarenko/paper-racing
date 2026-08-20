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

import { GameState } from '../../model/game';
import { NavField } from '../../model/nav';
import { strings } from '../../i18n';
import { renderRows } from '../components/classification';
import { burstConfetti, clearConfetti } from '../components/confetti';
import { bindTap } from '../primitives/dom';
import { raceActionSlot } from './race-chrome';
import { el, button, icon } from '../primitives/pr-chrome';
import { isPodium } from '../present/format';
import { PLAY_SVG, PODIUM_SVG, REMATCH_SVG, TROPHY_SVG } from '../primitives/icons';

const board = document.querySelector<HTMLElement>('.app__board')!;

export interface ResultHandlers {
  /** "Rematch" — same lineup, same track, no wizard. */
  onRematch: () => void;
  /** "Same track, new lineup" — keep the track, re-pick mode and players. */
  onSameTrack: () => void;
  /** "Draw a new track" — back to the editor (online: leaves the session). */
  onNewTrack: () => void;
  /** Online guest's exit from the rematch wait — frees the seat, leaves the room running. */
  onGuestLeave: () => void;
  /** "Replay" — watch the finished race drive itself again. */
  onReplay: () => void;
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
let replayBtn: HTMLButtonElement;
let guestEl: HTMLElement;
let waitDotsEl: HTMLElement;
let waitTextEl: HTMLElement;
let confettiEl: HTMLElement;
let built = false;
/** Was the full screen up on the previous render — the entrance runs on the
 *  false→true edge, and renderRaceResult runs on every render. */
let wasFullscreen = false;
let enterTimer = 0;
/** The burst has been fired for the race now on screen. Rearmed by state — a
 *  race with nobody home yet — rather than by object identity, because online
 *  replaces the whole GameState on every message from the room. */
let celebrated = false;

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
  const cardHead = el('div', 'pr-result__cardhead', cardEl);
  el('span', 'pr-label', cardHead).textContent = strings.race.classification;
  // Watching the race back belongs to the classification, not to the three ways
  // on from here: it's this table happening, and it leaves you where you were.
  replayBtn = button('pr-btn pr-btn--sm pr-btn--caps', cardHead);
  icon('pr-btn__ico', PLAY_SVG, replayBtn);
  el('span', 'pr-result__btntext', replayBtn).textContent = strings.buttons.replay;
  bindTap(replayBtn, h.onReplay);
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
  // bindTap, not a bare click: this screen arrives straight after a gesture on the
  // canvas, and that's exactly when iOS drops the first synthetic click on a button
  // that just appeared — "Rematch" would need a second tap (see ui/primitives/dom.ts).
  bindTap(rematchBtn, h.onRematch);
  sameTrackBtn = button('pr-btn pr-btn--caps', actionsEl);
  sameTrackBtn.textContent = strings.buttons.sameTrackNewMode;
  bindTap(sameTrackBtn, h.onSameTrack);
  newTrackBtn = button('pr-btn pr-btn--caps', actionsEl);
  newTrackBtn.textContent = strings.buttons.newTrack;
  bindTap(newTrackBtn, h.onNewTrack);

  // A guest can't start anything — the track's creator owns the room, and the
  // guest is dropped straight into the new race when they do. So they get a
  // dashed "waiting" plate where the buttons would be, not disabled buttons.
  // Only for the real end-of-race rematch wait — during an early exit the
  // guest isn't waiting on anything, they can still just leave.
  guestEl = el('div', 'pr-result__guest', inner);
  const waitEl = el('div', 'pr-result__wait', guestEl);
  // The shared waiting indicator — the same dots the race chip runs.
  waitDotsEl = el('span', 'pr-dots', waitEl);
  for (let i = 0; i < 3; i++) el('span', 'pr-dots__dot', waitDotsEl);
  waitTextEl = el('span', 'pr-result__waittext', waitEl);
  // ...but waiting is not the only thing they can do. Without this the screen is
  // a dead end: no buttons, and a reload just restores the finished race from
  // the snapshot. Leaving frees the seat; the rematch still runs without us.
  const guestLeaveBtn = button('pr-btn pr-btn--caps', guestEl);
  guestLeaveBtn.textContent = strings.online.leaveRace;
  bindTap(guestLeaveBtn, h.onGuestLeave);

  board.append(root);

  // A layer of the board's own, not a child of this screen: the poppers go off
  // when the winner crosses the line, and at that moment the race is still up —
  // the result screen may be seconds away, or (hot-seat) never come at all.
  // Deaf to the pointer, so it never comes between a tap and a button.
  confettiEl = el('div', 'pr-confetti', board);
  confettiEl.setAttribute('aria-hidden', 'true');
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
  /** The lone human racing bots, or −1 — their final row is signed "Me" too. */
  soloSeat?: number;
  /** In an online race and not the host: the rematch isn't ours to start. */
  onlineGuest: boolean;
  /** Online: the creator has left the room, so no rematch is coming — nothing to wait for. */
  hostGone: boolean;
  /** Whether a one-tap rematch is available at all (a saved lineup, or host online). */
  canRematch: boolean;
  /** Online: "same track, new lineup" runs the local wizard, which would desync the room. */
  isOnline: boolean;
  /** Whether this race has anything to replay (a race resolved without a single
   *  move driven has nothing to show). */
  canReplay: boolean;
}

/**
 * Headline block. Three outcomes, and the difference between the first two is
 * whether the winner is you: "You won" in your own colour, or "<name> in 1st
 * place" in theirs — someone else's win reads as a line of the classification. Nobody finishing is neither — no trophy, no colour, just what happened.
 */
function renderHead(game: GameState, mySeat: number): void {
  const { winner } = game;
  iconEl.replaceChildren();
  iconEl.hidden = false;
  subtitleEl.hidden = false;
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
  const sub = mine ? strings.race.youWonSub : loserSub(game, winner, mySeat);
  subtitleEl.textContent = sub ?? '';
  subtitleEl.hidden = sub === null;
}

/**
 * The subtitle for a screen whose reader didn't win — `null` means show none.
 *
 * With a seat of our own (online, or the one human against bots) it's personal:
 * "better luck next time" is wrong for a driver who came third of six, and the
 * size of the field is what decides (see `isPodium`).
 *
 * Hot-seat has no "you" — everyone shares this screen — so it speaks about the
 * race instead. One of the people here winning is worth congratulating; humans
 * beaten by the bots into the bottom half get the consolation line, which is
 * about the group and still true. In between (a human placed well, but a bot
 * took it) neither line fits, and the headline plus the classification already
 * say everything — so nothing is shown rather than something addressed at
 * nobody.
 */
function loserSub(game: GameState, winner: number, mySeat: number): string | null {
  const total = game.players.length;
  if (mySeat >= 0) {
    const place = game.players[mySeat].place;
    return place !== null && isPodium(place, total)
      ? strings.race.podiumSub(place)
      : strings.race.someoneWonSub;
  }
  if (!game.players[winner].bot) return strings.race.hotseatWonSub;
  const humans = game.players.filter((p) => !p.bot);
  const allBeaten = humans.every((p) => p.place === null || !isPodium(p.place, total));
  return allBeaten ? strings.race.someoneWonSub : null;
}

/** How long the entrance runs, ms — after this the class comes off, so a later
 *  re-render (an online guest's wait ticking over) doesn't replay it. */
const ENTER_MS = 900;

/**
 * Is there something to celebrate for whoever is reading this screen? Same line
 * the headline draws (see renderHead/loserSub): your own win, a dead heat you
 * were in, or — hot-seat, where there is no "you" — a win by one of the people
 * at this device. Being beaten, and a race nobody finished, get the entrance
 * without the confetti.
 */
function worthCelebrating(game: GameState, mySeat: number): boolean {
  const { winner } = game;
  if (winner === null) return false;
  if (mySeat >= 0) {
    return winner === 'draw' ? game.players[mySeat].place === 1 : winner === mySeat;
  }
  return winner === 'draw' || !game.players[winner].bot;
}

/**
 * Has the win already happened, whatever the rest of the field is still doing?
 * Winning is the moment you cross the line — the poppers go off then, not
 * minutes later when the last bot parks and the result screen opens. Same
 * addressee as worthCelebrating: your seat, or (hot-seat) any of the people
 * sharing this device.
 */
function firstPlaceLanded(game: GameState, mySeat: number): boolean {
  return mySeat >= 0
    ? game.players[mySeat].place === 1
    : game.players.some((p) => !p.bot && p.place === 1);
}

/** One burst per race, whichever moment gets there first. */
function celebrate(game: GameState): void {
  if (celebrated) return;
  celebrated = true;
  burstConfetti(
    confettiEl,
    game.players.map((p) => p.color),
  );
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
    soloSeat = -1,
    onlineGuest,
    hostGone,
    canRematch,
    isOnline,
    canReplay,
  } = ctx;
  const ready = !!game && !!nav;
  const fullscreen = over && ready;
  const docked = !over && earlyExit && ready;

  // The celebration is judged against the race, not against this screen: it can
  // fire while the board is still live, and it must be rearmed by the next race
  // even if the result screen never opened (a hot-seat race abandoned mid-way).
  if (ready) {
    if (game!.players.every((p) => p.place === null)) celebrated = false;
    else if (firstPlaceLanded(game!, mySeat)) celebrate(game!);
  }

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

  // Leaving the screen (a rematch, a new track): take the celebration down and
  // arm the entrance again, so the next race gets its own.
  if (!fullscreen && wasFullscreen) {
    wasFullscreen = false;
    if (enterTimer) clearTimeout(enterTimer);
    enterTimer = 0;
    root.classList.remove('pr-result--enter');
    clearConfetti(confettiEl);
  }

  if (!fullscreen && !docked) return;

  if (fullscreen) {
    labelEl.textContent = strings.race.raceComplete;
    replayBtn.hidden = !canReplay;
    renderHead(game!, mySeat);
    renderRows(rowsEl, game!, nav!, { mySeat, soloSeat, final: true });
    // The flag has just fallen — the one moment in the app worth marking.
    if (!wasFullscreen) {
      wasFullscreen = true;
      root.classList.add('pr-result--enter');
      enterTimer = window.setTimeout(() => {
        enterTimer = 0;
        root.classList.remove('pr-result--enter');
      }, ENTER_MS);
      // Usually already fired at the finish line; this catches the outcomes
      // that only exist once the whole field is home — a dead heat, and a
      // hot-seat race whose winner was decided by the last car parking.
      if (worthCelebrating(game!, mySeat)) celebrate(game!);
    }
  }

  // A guest waits for the host only for the real end-of-race rematch — during
  // an early exit there's nothing to wait for, they can just leave.
  const guestWaiting = onlineGuest && over;
  actionsEl.hidden = guestWaiting;
  guestEl.hidden = !guestWaiting;
  // Once the creator is gone the plate keeps the way out but drops the promise: no
  // one is left to start a rematch, so the dots stop pretending something's coming.
  waitDotsEl.hidden = hostGone;
  waitTextEl.textContent = hostGone
    ? strings.online.hostLeftNoRematch
    : strings.online.rematchWaiting;
  // Only offer a rematch when there's something to replay (online rematch
  // also requires the room to actually be over — canRematch already covers that).
  rematchBtn.hidden = !canRematch;
  // "Same track, new lineup" walks back into the local wizard, which would
  // desync a live room — online that leaves "Rematch" and "Draw a new track"
  // (which, online, means leaving the session).
  sameTrackBtn.hidden = isOnline;
}
