// Shared Blueprint chrome helpers (redesign): the tiny DOM builders, the inline
// icons and the top bar that every redesigned screen assembles itself from.
// Styling lives in styles/pr-controls.css — this module only builds markup, so
// each screen's owner module (editor-chrome.ts, setup-chrome.ts) stays about its
// own layout and state.

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

export const BURGER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
export const BACK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H6M11 6l-6 6 6 6"/></svg>';
export const ARROW_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>';
export const CHEVRON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
export const CLOSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
export const RULES_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.1 9.5a2.9 2.9 0 1 1 4.4 2.5c-1 .6-1.5 1.1-1.5 2.1"/><circle cx="12" cy="17.2" r=".4" fill="currentColor" stroke="none"/></svg>';
/** Globe with meridians — the online mode card and "join by code". */
export const GLOBE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M4.5 7.5h15M4.5 16.5h15"/></svg>';
export const LANG_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>';

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
  logo.src = `${import.meta.env.BASE_URL}pwa-192x192.png`;
  logo.alt = '';
  const text = el('span', 'pr-brand__text', brand);
  const mark = el('span', 'pr-brand__wordmark', text);
  el('span', 'pr-brand__word', mark).textContent = 'Paper';
  el('span', 'pr-brand__word pr-brand__word--accent', mark).textContent = ' Racing';
  const dashes = el('span', 'pr-brand__dashes', text);
  for (let i = 0; i < opts.dashes; i++) {
    el(
      'span',
      i % 2 ? 'pr-brand__dash pr-brand__dash--hollow' : 'pr-brand__dash',
      dashes,
    );
  }
  return brand;
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
