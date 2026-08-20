// What the race screens should show, worked out from the state — the presenter
// half of the old updateUI fan-out in main.ts.
//
// Everything here is pure, which is the point: the decisions below disagree
// across the three modes (online / vs bots / hotseat), and getting one of them
// wrong is silent — the screen just quietly addresses the wrong player. Now
// they are covered by screen-props.test.ts instead.
//
// Network facts (whose turn it is over the wire, whether the socket is up,
// whether the host left) stay main.ts's to fetch and arrive here as data; a
// presenter that reached for the session itself would be untestable again.
//
// In ui/ rather than model/ by the project's own boundary: a pure presenter is
// still presentation (see ui/present/format.ts).

import { AppState, NetTurn } from '../../app-state';
import { humansAllDone, isFinished } from '../../model/game';
import { SeatCtx, isBotSeat, soloHumanSeat, localHumanSeat } from '../../seats';
// Type-only on purpose: present/ sits below screens/ in the layering, and these
// two are the one place it looks upward. `import type` is erased at build time,
// so the arrow exists for the typechecker and not in the module graph.
import type { RaceCtx } from '../screens/race-chrome';
import type { ResultCtx } from '../screens/race-result';

export interface ScreenInput {
  state: AppState;
  /** Our own seat in an online room; null in a local game (see seats.ts). The
   *  rest of the seat context is read off `state`, so the two can't disagree. */
  mySeat: number | null;
  /** Online context for the current turn; null in a local game. */
  net: NetTurn | null;
  /** Realtime channel is up. Only meaningful online. */
  connected: boolean;
  /** Online: the room's creator has left. */
  hostGone: boolean;
  /** Online: the room can be restarted by us (we're the host). The local half
   *  of "can we rematch" is derived here from the saved lineup. */
  onlineCanRematch: boolean;
}

function seatCtx(i: ScreenInput): SeatCtx {
  return { game: i.state.game, phase: i.state.phase, mySeat: i.mySeat };
}

/** Are we in an online room at all? That is exactly "we own a seat". */
function isOnline(i: ScreenInput): boolean {
  return i.mySeat !== null;
}

/**
 * The lone human racing bots, or −1 — the seat both screens address as "you"
 * instead of naming a car colour. Online and hotseat keep names: there the name
 * is what tells two people apart.
 */
function soloSeat(i: ScreenInput): number {
  return isOnline(i) ? -1 : soloHumanSeat(i.state.game);
}

export function raceChromeProps(i: ScreenInput): RaceCtx {
  const { game } = i.state;
  return {
    phase: i.state.phase,
    game,
    nav: i.state.raceNav,
    net: i.net,
    // A bot is moving right now (local game) — don't show the "tap a point" hint.
    aiTurn: !!game && isBotSeat(game, game.current),
    // Whose row gets the amber "you're up" treatment: our own seat online, the
    // human at the controls locally (hot-seat players share this client).
    mySeat: localHumanSeat(seatCtx(i)),
    soloSeat: soloSeat(i),
    connected: i.connected,
  };
}

export function raceResultProps(i: ScreenInput): ResultCtx {
  const { game } = i.state;
  const over = i.state.phase === 'race' && game?.phase === 'over';
  return {
    game,
    nav: i.state.raceNav,
    over,
    earlyExit: earlyExit(i, over),
    // Whose result this is, personally: our own seat online, the one human in a
    // race against bots. Hot-seat is the only mode with no single "you" (every
    // player shares this screen), so there it stays −1 and nobody gets the
    // personal treatment.
    mySeat: i.mySeat ?? soloHumanSeat(game),
    soloSeat: soloSeat(i),
    onlineGuest: !!i.net && !i.net.isHost,
    hostGone: isOnline(i) && i.hostGone,
    // One tap repeats the last lineup: locally that needs a race and a saved
    // lineup to repeat, online it's the host's to start.
    canRematch: (!!game && !!i.state.lastLocalRace) || i.onlineCanRematch,
    isOnline: isOnline(i),
    // A race resolved without a single move driven has nothing to replay.
    canReplay: !!game && game.players.some((p) => p.trail.length > 0),
  };
}

/**
 * No human has anything left to do, but the race hasn't resolved yet (bots may
 * still be racing it out). Online that is judged per our own seat — every client
 * has its own screen; locally (solo-vs-bots or hotseat) it is judged across
 * every human seat, since they all share this one.
 */
function earlyExit(i: ScreenInput, over: boolean): boolean {
  const { game } = i.state;
  if (over || !game) return false;
  const mine = i.mySeat;
  if (mine === null) return humansAllDone(game);
  return mine !== -1 && (game.players[mine].retired || isFinished(game.players[mine]));
}
