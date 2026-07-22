// Standings strip above the map, F1-broadcast style: a stack of rows —
// "position — car — name" — sorted from leader to last place. The order
// freezes at lap boundaries (see frozenOrder below) — mid-lap it's transient,
// since cars have made different numbers of moves; row statuses stay live
// regardless. Finishers get 🏁 plus their placing, retirees get 🏳️. The
// order itself comes from computeStandings() (by placing / by remaining
// distance). The module owns its root element and mounts it into .app__board
// on first render — there's no markup for it in index.html (we keep
// index.html lean, see roadmap).

import { GameState } from '../model/game';
import { NavField } from '../model/nav';
import { computeStandings } from '../model/standings';
import { strings } from '../i18n';

let root: HTMLElement | null = null;

// We freeze the standings order at lap boundaries: mid-lap, different cars
// have made different numbers of moves (the one currently moving has already
// gone, the rest haven't), so a "live" order would be transient and jump
// around. We only recompute computeStandings once a full lap completes
// (floor(turn/n) increases) — at that point every car in the lap has had its
// turn, so the comparison is fair. Between boundaries we keep the frozen
// order; row statuses (🏁/🏳️/current) stay live regardless — only the sort
// order is frozen.
let frozenOrder: number[] = [];
let frozenRound = -1;
let frozenCount = 0;

/** Create the strip's root element and mount it above the map (once). */
function mount(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'standings';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', strings.race.standingsLabel);
  el.hidden = true;
  (document.querySelector('.app__board') ?? document.body).append(el);
  return el;
}

/** A single row: position/status, the car's colored dot, and name. */
function row(game: GameState, seat: number, index: number): HTMLElement {
  const p = game.players[seat];
  const el = document.createElement('div');
  el.className = 'standings__row';
  if (p.place !== null) el.classList.add('standings__row--finished');
  else if (p.retired) el.classList.add('standings__row--retired');
  else if (game.phase === 'race' && game.current === seat)
    el.classList.add('standings__row--current');

  const pos = document.createElement('span');
  pos.className = 'standings__pos';
  // A finisher gets 🏁 plus their actual (possibly tied) placing; a retiree
  // gets 🏳️; a car still racing shows its current overall position (row index).
  pos.textContent = p.retired ? '🏳️' : p.place !== null ? `🏁${p.place}` : `${index + 1}`;

  const dot = document.createElement('span');
  dot.className = 'standings__dot';
  dot.style.background = p.color;

  const name = document.createElement('span');
  name.className = 'standings__name';
  name.textContent = p.name;

  el.append(pos, dot, name);
  return el;
}

/**
 * Update the standings strip. Shown during an active or finished race (after
 * the finish it's the final classification); hidden otherwise. nav is the
 * track's navigation field, used to estimate remaining distance for cars
 * still racing.
 */
export function renderStandings(game: GameState | null, nav: NavField | null): void {
  if (!root) root = mount();
  if (!game || !nav || (game.phase !== 'race' && game.phase !== 'over')) {
    root.hidden = true;
    root.replaceChildren();
    frozenRound = -1; // reset on leaving the race — a new race recomputes from scratch
    return;
  }
  const n = game.players.length;
  const round = Math.floor(game.turn / n);
  // Recompute the order at a lap boundary, when the player count changes (a
  // different race), or once the race is over (final classification).
  // Otherwise keep the frozen order.
  if (round !== frozenRound || n !== frozenCount || game.phase === 'over') {
    frozenOrder = computeStandings(game, nav);
    frozenRound = round;
    frozenCount = n;
  }
  root.replaceChildren(...frozenOrder.map((seat, i) => row(game, seat, i)));
  root.hidden = false;
}
