// Shared Blueprint chrome helpers (redesign): the tiny DOM builders and the top
// bar that every redesigned screen assembles itself from. The icon set they draw
// from lives next door in icons.ts.
// Styling lives in styles/pr-controls.css — this module only builds markup, so
// each screen's owner module (editor-chrome.ts, setup-chrome.ts) stays about its
// own layout and state.

import { Difficulty } from '../model/ai';
import { CHEVRON_SVG, COPY_SVG, SHARE_SVG } from './icons';

/** Create an element with a class, optionally appending it to a parent. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (parent) parent.append(e);
  return e;
}

/** A <button type="button"> with a class (the app's controls are never submits). */
export function button(cls: string, parent?: HTMLElement): HTMLButtonElement {
  const b = el('button', cls, parent);
  b.type = 'button';
  return b;
}

/** An inline SVG icon (paths pre-composed) wrapped in a span. */
export function icon(cls: string, inner: string, parent: HTMLElement): HTMLElement {
  const span = el('span', cls, parent);
  span.innerHTML = inner;
  return span;
}

/**
 * A tappable list row: icon tile, title (+ optional subtitle), optional chevron.
 * The mode-select cards and the global menu's entries are the same component —
 * `cls` carries the surface each screen needs (a `.pr-card` under the mode
 * cards, `.pr-item--fill` for the menu's soft-filled rows).
 */
export function buildItem(
  parent: HTMLElement,
  opts: { cls?: string; iconSvg: string; title: string; sub?: string; chevron?: boolean },
): HTMLButtonElement {
  const row = button(`pr-item${opts.cls ? ' ' + opts.cls : ''}`, parent);
  icon('pr-item__ico', opts.iconSvg, row);
  const text = el('span', 'pr-item__text', row);
  el('span', 'pr-item__title', text).textContent = opts.title;
  if (opts.sub) el('span', 'pr-item__sub', text).textContent = opts.sub;
  if (opts.chevron) icon('pr-item__chev', CHEVRON_SVG, row);
  return row;
}

/**
 * The app's brand mark: icon, skewed wordmark and a checkered rule under it.
 * Shared by the menu drawer's header and the editor's wide-screen rail (`--sm`),
 * which differ only in size and in how many dashes fit.
 */
export function buildBrand(
  parent: HTMLElement,
  opts: { cls?: string; dashes: number } = { dashes: 8 },
): HTMLElement {
  const brand = el('span', `pr-brand${opts.cls ? ' ' + opts.cls : ''}`, parent);
  const logo = el('img', 'pr-brand__logo', brand);
  // The vector flag, not the pencil-drawn PNG: that one is the launcher icon and
  // stays there. At 28–34px its hatching turns to mush anyway.
  logo.src = `${import.meta.env.BASE_URL}favicon-v3.svg`;
  logo.alt = '';
  const text = el('span', 'pr-brand__text', brand);
  const mark = el('span', 'pr-brand__wordmark', text);
  // No space between the words: the wordmark is a flex row, so the gap is the gap.
  el('span', 'pr-brand__word', mark).textContent = 'Paper';
  el('span', 'pr-brand__word pr-brand__word--accent', mark).textContent = 'Racing';
  const dashes = el('span', 'pr-brand__dashes', text);
  for (let i = 0; i < opts.dashes; i++) {
    el('span', i % 2 ? 'pr-brand__dash pr-brand__dash--slate' : 'pr-brand__dash', dashes);
  }
  return brand;
}

// ── Online-lobby components ─────────────────────────────────────────────────
// Room code, roster and the waiting banner are the same three blocks on both
// lobby screens — the host's (inside race setup) and the guest's — so they live
// here rather than in either owner module.

/** The room code with its two actions: tap the code to copy, the button to share. */
export interface CodeBlock {
  root: HTMLElement;
  /** Show a code (the room's) — call on every render, it's cheap. */
  set(code: string): void;
}

export function buildCode(
  parent: HTMLElement,
  opts: { onCopy: () => void; onShare: () => void },
): CodeBlock {
  const root = el('div', 'pr-code', parent);
  const codeBtn = button('pr-code__value', root);
  const text = el('span', 'pr-code__text', codeBtn);
  icon('pr-code__ico', COPY_SVG, codeBtn);
  codeBtn.addEventListener('click', opts.onCopy);
  const shareBtn = button('pr-btn pr-btn--icon pr-code__share', root);
  icon('pr-btn__ico', SHARE_SVG, shareBtn);
  shareBtn.addEventListener('click', opts.onShare);
  return { root, set: (code) => (text.textContent = code) };
}

/** One racer as the roster shows them. `name` may be empty — see renderRoster. */
export interface RosterPlayer {
  name: string;
  color: string;
  /** This client's own seat: its name is editable in place. */
  you: boolean;
  /** Marked with the HOST badge (the client that owns the track). */
  host: boolean;
  /** Not currently connected — the row dims and says so. */
  offline: boolean;
}

export interface Roster {
  root: HTMLElement;
  /**
   * Draw the roster. `emptyNote` (when given) is the dashed line shown under a
   * roster of one — "share the code, nobody's here yet".
   */
  render(players: RosterPlayer[], emptyNote?: string | null): void;
}

/**
 * The player list. Rows are reused across renders rather than rebuilt: your own
 * row holds a live <input> for your name, and replacing it mid-render would
 * drop the caret on every keystroke (each one echoes back through realtime).
 *
 * A player who hasn't typed a name yet reads as their car's colour to everyone
 * else — the same fallback the race itself uses — while their own row stays an
 * empty field with the placeholder, so it still invites a name.
 */
export function buildRoster(
  parent: HTMLElement,
  opts: { placeholder: string; hostBadge: string; youBadge: string; offline: string },
  onRename?: (name: string) => void,
): Roster {
  const root = el('div', 'pr-roster', parent);
  const list = el('div', 'pr-roster__list', root);
  const empty = el('div', 'pr-roster__empty', root);
  empty.hidden = true;

  interface Row {
    root: HTMLElement;
    dot: HTMLElement;
    name: HTMLElement;
    input: HTMLInputElement;
    badge: HTMLElement;
  }
  const rows: Row[] = [];

  const addRow = (): Row => {
    const row = el('div', 'pr-roster__row', list);
    const dot = el('span', 'pr-roster__dot', row);
    const name = el('span', 'pr-roster__name', row);
    const input = el('input', 'pr-roster__input', row);
    input.type = 'text';
    input.maxLength = 20;
    input.placeholder = opts.placeholder;
    input.hidden = true;
    if (onRename) {
      input.addEventListener('input', () => onRename(input.value));
      // Enter is "I'm done" on a phone keyboard — close it rather than submit
      // anything (there's no form; the value is already on its way).
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });
    }
    const badge = el('span', 'pr-roster__badge', row);
    return { root: row, dot, name, input, badge };
  };

  const render = (players: RosterPlayer[], emptyNote?: string | null): void => {
    while (rows.length > players.length) rows.pop()!.root.remove();
    while (rows.length < players.length) rows.push(addRow());
    players.forEach((p, i) => {
      const row = rows[i];
      row.root.classList.toggle('pr-roster__row--offline', p.offline);
      row.root.classList.toggle('pr-roster__row--you', p.you);
      row.dot.style.background = p.color;
      row.name.hidden = p.you;
      row.input.hidden = !p.you;
      if (p.you) {
        // Never write over what's being typed — the value is already ours, and
        // the echo of our own rename would otherwise reset the caret.
        if (document.activeElement !== row.input) row.input.value = p.name;
      } else {
        row.name.textContent = p.name;
      }
      const badge = p.host
        ? opts.hostBadge
        : p.offline
          ? opts.offline
          : p.you
            ? opts.youBadge
            : '';
      row.badge.textContent = badge;
      row.badge.hidden = !badge;
      row.badge.classList.toggle('pr-roster__badge--host', p.host);
    });
    empty.textContent = emptyNote ?? '';
    empty.hidden = !emptyNote;
  };

  return { root, render };
}

/**
 * Everything a lobby screen draws. Assembled in one place (online/host-bots.ts)
 * from the session, and rendered by whichever screen is showing: the host's
 * lobby is the race-setup card's Lineup tab, the guest's is its own screen.
 */
export interface LobbyView {
  code: string;
  players: RosterPlayer[];
  /** Seats on this track's starting grid — the roster's capacity. */
  seats: number;
  isHost: boolean;
  /** Enough racers have joined for the host to start. */
  canStart: boolean;
  /** Our own name is still empty — the one thing holding the host back. */
  needsName: boolean;
  /** Host-local bot fill (only the host sets these). */
  botCount: number;
  maxBots: number;
  botDifficulty: Difficulty;
  /** Realtime channel is up — false puts the status banner into its error skin. */
  connected: boolean;
  /** The host's start write is in flight. */
  starting: boolean;
}

/**
 * Persistent state banner: a spinner and a line of text that stays put for as
 * long as the state lasts ("waiting for the host", "reconnecting"). Deliberately
 * NOT the toast — a toast auto-dismisses, and this has to survive the wait.
 */
export interface StatusBanner {
  root: HTMLElement;
  set(text: string, error?: boolean): void;
}

export function buildStatus(parent: HTMLElement): StatusBanner {
  const root = el('div', 'pr-status', parent);
  el('span', 'pr-status__spinner', root);
  const text = el('span', 'pr-status__text', root);
  return {
    root,
    set(t, error = false) {
      text.textContent = t;
      root.classList.toggle('pr-status--error', error);
    },
  };
}

/**
 * A modal sheet, mounted into #overlay and hidden until its owner opens it.
 * The surface is the shared solid card, so a sheet reads as the same material
 * as the menu drawer and the coach-mark. Callers append their own content and
 * buttons; `openSheet`/`closeOverlay` (ui/dom.ts) do the showing.
 */
export function buildSheet(title: string): HTMLElement {
  const overlay = document.getElementById('overlay')!;
  const sheet = el('div', 'pr-card pr-card--lg pr-card--solid pr-sheet', overlay);
  sheet.hidden = true;
  el('h2', 'pr-sheet__title', sheet).textContent = title;
  return sheet;
}

export interface Topbar {
  root: HTMLElement;
  /** The 48px leading icon button (burger in the editor, back elsewhere). */
  lead: HTMLButtonElement;
  /** The title card — screens append their own extras (counter, progress). */
  head: HTMLElement;
  title: HTMLElement;
}

/**
 * The screen top bar: a square icon button next to a title card, both aligned to
 * the shared gutter. The leading button's meaning is the screen's business —
 * pass the icon markup, the accessible label and the tap handler.
 */
export function buildTopbar(
  parent: HTMLElement,
  opts: { iconSvg: string; label: string; onTap: () => void },
): Topbar {
  const root = el('div', 'pr-topbar', parent);
  const lead = button('pr-btn pr-btn--icon', root);
  lead.setAttribute('aria-label', opts.label);
  icon('pr-btn__ico', opts.iconSvg, lead);
  lead.addEventListener('click', opts.onTap);
  const head = el('div', 'pr-card pr-topbar__head', root);
  const title = el('span', 'pr-label pr-topbar__title', head);
  return { root, lead, head, title };
}
