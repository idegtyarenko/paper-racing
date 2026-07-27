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
