// The classification: standings order plus the row renderer, shared by the two
// screens that show it — the live race HUD (ui/screens/race-chrome.ts) and the result
// layer (ui/screens/race-result.ts). It lives here rather than in either of them so a
// racer reads the same way mid-race and at the flag, and so the "who's ahead"
// ordering has one owner.

import { KMH_PER_CELL } from '../../config';
import { GameState, Player } from '../../model/game';
import { NavField } from '../../model/nav';
import { computeStandings, turnsTaken } from '../../model/standings';
import { len } from '../../geometry';
import { strings } from '../../i18n';
import { el, icon } from '../primitives/pr-chrome';
import { BOT_SVG, CLOCK_SVG, CRASH_SVG } from '../primitives/icons';

// ── Standings order ──────────────────────────────────────────────────────────
// Frozen at lap boundaries: mid-lap, different cars have made different numbers
// of moves (the one currently moving has already gone, the rest haven't), so a
// live order would be transient and jump around. We only recompute once a full
// lap completes — at that point every car in the lap has had its turn, so the
// comparison is fair. Row statuses stay live regardless; only the sort is frozen.
let frozenOrder: number[] = [];
let frozenRound = -1;
let frozenCount = 0;

export function standingsOrder(game: GameState, nav: NavField): number[] {
  const n = game.players.length;
  const round = Math.floor(game.turn / n);
  if (round !== frozenRound || n !== frozenCount || game.phase === 'over') {
    frozenOrder = computeStandings(game, nav);
    frozenRound = round;
    frozenCount = n;
  }
  return frozenOrder;
}

/** Forget the frozen order — a new race must not inherit the last one's. */
export function resetStandings(): void {
  frozenRound = -1;
}

/** A count behind a monochrome glyph — the pit countdown and the crash tally. */
function badge(parent: HTMLElement, cls: string, svg: string, n: number): void {
  const b = el('span', cls, parent);
  icon('pr-race__ico', svg, b);
  el('span', 'pr-race__statnum', b).textContent = String(n);
}

/**
 * The row's right-hand slot: whatever this car's state calls for.
 *
 * The leading item is mutually exclusive — a placing, "retired", "stalled", the
 * pit countdown, or the speedometer, in that order. The crash tally is not: it's
 * a running total for the whole race, so it trails whichever of those is showing
 * (a car sitting in the gravel is exactly when its count has just gone up, and
 * that's the worst moment to hide it).
 *
 * Once the race is over (`final`) a finisher shows the number of moves it took
 * rather than its placing: the placing is already the row's position in the
 * list, whereas the move count is the actual score of a paper race — and the
 * only thing separating two cars that share a place.
 */
function rowStatus(p: Player, opts: { stalled: boolean; final: boolean }): HTMLElement {
  const slot = el('span', 'pr-race__stat');
  if (p.retired) {
    slot.classList.add('pr-race__stat--out');
    slot.textContent = strings.race.retired;
    return slot;
  }
  if (p.place !== null) {
    slot.classList.add('pr-race__stat--done');
    slot.textContent = opts.final
      ? strings.race.moves(turnsTaken(p))
      : strings.race.finished(p.place);
    return slot;
  }
  if (opts.stalled) {
    slot.classList.add('pr-race__stat--warn');
    slot.textContent = strings.race.stalled;
    return slot;
  }
  if (p.skipTurns > 0) {
    // Serving a crash penalty: the turns still to sit out, not a speed (it's zero).
    slot.classList.add('pr-race__stat--warn');
    badge(slot, 'pr-race__pit', CLOCK_SVG, p.skipTurns);
  } else {
    // Convert the velocity-vector length into notional km/h and round to the
    // nearest ten — like the gradations on a real speedometer.
    const kmh = Math.round((len(p.vel) * KMH_PER_CELL) / 10) * 10;
    el('span', 'pr-race__kmh', slot).textContent = String(kmh);
    el('span', 'pr-race__unit', slot).textContent = strings.race.speedUnit;
  }
  if (p.crashes.length > 0) badge(slot, 'pr-race__crashes', CRASH_SVG, p.crashes.length);
  return slot;
}

export interface RowCtx {
  /** This client's seat, or −1 — the row that gets the amber "you're up" tint. */
  mySeat: number;
  /**
   * The lone human in a local race against bots, or −1. Their row is signed
   * "Me" rather than their car colour: there's exactly one addressee, and the
   * colour tells them nothing they don't already see in the swatch. Hot-seat
   * and online keep colour names — there the name distinguishes people.
   */
  soloSeat?: number;
  /** Seat whose turn has stalled past the timer and can be skipped; −1 if none. */
  stalledSeat?: number;
  /** Seats whose tab is currently offline (index = seat). */
  present?: boolean[];
  /** The race is over: the card is the final classification, not a live readout. */
  final?: boolean;
}

/**
 * One classification row: position, car swatch, name, status slot.
 *
 * Highlight convention from the hi-fi, and it's a two-tier signal rather than a
 * decoration: the row of whoever is moving is tinted in THEIR car colour
 * (informational — you can see whose turn it is), except when that's you, in
 * which case it goes amber, the app's one "act now" colour (same as Confirm
 * move, Start race). So "someone is moving" and "you are up" never look alike.
 * Once the race is over the same two tiers mark the winner instead — there's no
 * mover left to point at.
 */
export function buildRow(
  game: GameState,
  seat: number,
  index: number,
  ctx: RowCtx,
): HTMLElement {
  const p = game.players[seat];
  const row = el('div', 'pr-race__row');
  const highlight = ctx.final
    ? p.place === 1 && !p.retired
    : game.phase === 'race' && game.current === seat;
  if (highlight) {
    const mine = seat === ctx.mySeat;
    row.classList.add(mine ? 'pr-race__row--mine' : 'pr-race__row--current');
    // Your own live turn breathes — the row is the "act now" signal, and on the
    // result screen `--mine` means "you won" instead, which must sit still. A
    // modifier of its own rather than un-animating it there by specificity.
    if (mine && !ctx.final) row.classList.add('pr-race__row--acting');
    // The other-car tint is that car's own colour, so it can't be a class.
    if (!mine) row.style.setProperty('--pr-row-tint', p.color);
  }
  if (p.place !== null || p.retired) row.classList.add('pr-race__row--out');
  if (ctx.present?.[seat] === false) {
    row.classList.add('pr-race__row--offline');
    row.title = strings.online.offline;
  }

  const pos = el('span', 'pr-race__pos', row);
  // A finisher keeps their actual (possibly tied) placing; a retiree has none;
  // everyone still racing shows their current overall position (row index).
  pos.textContent = p.retired
    ? '–'
    : p.place !== null
      ? String(p.place)
      : String(index + 1);

  el('span', 'pr-race__swatch', row).style.background = p.color;
  // A bot is marked by an icon rather than a prefix welded into its name: the
  // name travels through the online state and every other place it's shown,
  // and only this row has somewhere to put a mark.
  if (p.bot) icon('pr-race__bot', BOT_SVG, row);
  el('span', 'pr-race__name', row).textContent =
    seat === ctx.soloSeat ? strings.race.you : p.name;
  row.append(rowStatus(p, { stalled: seat === ctx.stalledSeat, final: !!ctx.final }));
  return row;
}

/**
 * Draw the whole list into `target`. Both screens sort the same way and hand the
 * rows the same context; only `final` differs.
 */
export function renderRows(
  target: HTMLElement,
  game: GameState,
  nav: NavField,
  ctx: RowCtx,
): void {
  target.replaceChildren(
    ...standingsOrder(game, nav).map((seat, i) => buildRow(game, seat, i, ctx)),
  );
}
