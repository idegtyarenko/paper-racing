// The global (burger) menu: a left drawer over a scrim, holding the app-wide
// entries — Rules, Join by code, Language — and the build stamp. Its own owner
// module (the redesign's rule) even though only the editor's top bar opens it
// today; mounting the burger on the other screens is a later step.
//
// Shape follows hi-fi M2: brand header instead of a "Menu" title, icon-tiled
// rows (the shared .pr-item), an expandable language sublist with flags, and
// the close × as a floating button outside the drawer, mirroring the burger.

import { strings, setLocale, locale, LocaleCode } from '../i18n';
import { el, button, icon, buildItem, buildBrand } from './pr-chrome';
import { CHECK_SVG, CLOSE_SVG, FLAG_SVG, GLOBE_SVG, LANG_SVG, RULES_SVG } from './icons';

export interface MenuHandlers {
  /** Open the Rules / How-to-play sheet. */
  onRules: () => void;
  /** Open the join-by-code dialog. */
  onJoin: () => void;
  /** Whether "Retire from race" applies right now: a race is running and this
   *  client is still in it. Asked at open time, not at build time. */
  canRetire: () => boolean;
  /** Drop out of the race (asks for confirmation itself). */
  onRetire: () => void;
}

/** Flags from the hi-fi, 20×14. Not the state flags — the design's choice. */
const FLAG_EN =
  '<svg viewBox="0 0 60 40"><rect width="60" height="40" fill="#00247d"/><path d="M0,0 60,40M60,0 0,40" stroke="#fff" stroke-width="8"/><path d="M0,0 60,40M60,0 0,40" stroke="#cf142b" stroke-width="4"/><path d="M30,0V40M0,20H60" stroke="#fff" stroke-width="12"/><path d="M30,0V40M0,20H60" stroke="#cf142b" stroke-width="7"/></svg>';
const flagStripe = (color: string): string =>
  `<svg viewBox="0 0 3 2" preserveAspectRatio="none"><rect width="3" height="2" fill="#fff"/><rect y=".667" width="3" height=".667" fill="${color}"/></svg>`;

/** Language options — endonyms (not translated) with their flag. */
const LANGS: { code: LocaleCode; label: string; flag: string }[] = [
  { code: 'en', label: 'English', flag: FLAG_EN },
  { code: 'ru', label: 'Русский', flag: flagStripe('#4a9fe0') },
  { code: 'be', label: 'Беларуская', flag: flagStripe('#c8313e') },
];

/** Kept in step with the drawer's slide-out transition in menu.css. */
const CLOSE_MS = 180;

let handlers: MenuHandlers;
let root: HTMLElement | null = null;
let footEl: HTMLElement;
let retireItem: HTMLButtonElement;
let closeTimer = 0;

/** Build label ("<commit> · <date>") for the drawer's foot. Published by main.ts
 *  at startup, long before the drawer is built — hence a value here rather than
 *  a node the menu would have to scrape text out of. */
let version = '';
/** Five quick taps on the build label toggle the SW debug overlay (see main.ts). */
let onVersionTaps: () => void = () => {};

/**
 * Publish the build label. The stamp lives here alone: repeating it in the rules
 * sheet gave the same fact two homes, and the drawer is reachable from every
 * screen. `onTaps` fires on five quick taps on it.
 */
export function setVersionLabel(label: string, onTaps: () => void): void {
  version = label;
  onVersionTaps = onTaps;
  if (footEl) footEl.textContent = label;
}

/** Window within which taps count as part of the same burst. */
const VERSION_TAP_MS = 600;
const VERSION_TAPS = 5;

function bindVersionTaps(elem: HTMLElement): void {
  let taps = 0;
  let last = 0;
  elem.addEventListener('click', () => {
    const now = performance.now();
    taps = now - last < VERSION_TAP_MS ? taps + 1 : 1;
    last = now;
    if (taps < VERSION_TAPS) return;
    taps = 0;
    onVersionTaps();
  });
}

function build(): HTMLElement {
  const menu = el('div', 'pr-menu');
  menu.hidden = true;
  el('div', 'pr-menu__backdrop', menu).addEventListener('click', closeMenu);

  // The × mirrors the burger it replaces: same size, opposite gutter, over the
  // scrim rather than inside the drawer (hi-fi M2).
  const close = button('pr-btn pr-btn--icon pr-menu__close', menu);
  close.setAttribute('aria-label', strings.menu.title);
  icon('pr-btn__ico', CLOSE_SVG, close);
  close.addEventListener('click', closeMenu);

  const panel = el('div', 'pr-menu__panel', menu);
  buildBrand(panel, { cls: 'pr-menu__brand', dashes: 8 });
  el('div', 'pr-menu__rule', panel);

  const list = el('div', 'pr-menu__list', panel);
  // Retire heads the list and only exists mid-race (hi-fi 5I). Destructive, so
  // it's tinted red and goes through the confirmation sheet.
  retireItem = buildItem(list, {
    cls: 'pr-item--fill pr-menu__retire',
    iconSvg: FLAG_SVG,
    title: strings.race.retire,
  });
  retireItem.addEventListener('click', () => {
    closeMenu();
    handlers.onRetire();
  });
  buildItem(list, {
    cls: 'pr-item--fill',
    iconSvg: RULES_SVG,
    title: strings.menu.rules,
    chevron: true,
  }).addEventListener('click', () => {
    closeMenu();
    handlers.onRules();
  });
  buildItem(list, {
    cls: 'pr-item--fill',
    iconSvg: GLOBE_SVG,
    title: strings.menu.join,
    chevron: true,
  }).addEventListener('click', () => {
    closeMenu();
    handlers.onJoin();
  });

  // Language: the row expands into a sublist below it (the two read as one
  // block, so the row loses its bottom corners while open).
  const group = el('div', 'pr-menu__group', list);
  const langBtn = buildItem(group, {
    cls: 'pr-item--fill pr-menu__langbtn',
    iconSvg: LANG_SVG,
    title: strings.menu.language,
    chevron: true,
  });
  const langs = el('div', 'pr-menu__langs', group);
  langs.hidden = true;
  for (const l of LANGS) {
    const b = button('pr-menu__lang', langs);
    icon('pr-menu__flag', l.flag, b);
    el('span', 'pr-menu__langname', b).textContent = l.label;
    if (l.code === locale) {
      b.classList.add('pr-menu__lang--active');
      icon('pr-menu__check', CHECK_SVG, b);
    }
    b.addEventListener('click', () => setLocale(l.code));
  }
  langBtn.addEventListener('click', () => {
    langs.hidden = !langs.hidden;
    group.classList.toggle('pr-menu__group--open', !langs.hidden);
  });

  footEl = el('div', 'pr-menu__foot', panel);
  footEl.setAttribute('aria-hidden', 'true');
  bindVersionTaps(footEl);

  document.body.append(menu);
  return menu;
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeMenu();
}

export function initMenu(h: MenuHandlers): void {
  handlers = h;
}

export function openMenu(): void {
  if (!root) root = build();
  clearTimeout(closeTimer);
  root.classList.remove('pr-menu--closing');
  // Read at open time, not at build time: main.ts publishes the label on its
  // own schedule, so a value captured once could still be the empty default.
  footEl.textContent = version;
  retireItem.hidden = !handlers.canRetire();
  root.hidden = false;
  document.addEventListener('keydown', onKeyDown);
}

export function closeMenu(): void {
  if (!root || root.hidden) return;
  document.removeEventListener('keydown', onKeyDown);
  // Play the slide-out, then hide for real (`hidden` kills the animation).
  root.classList.add('pr-menu--closing');
  closeTimer = window.setTimeout(() => {
    if (!root) return;
    root.hidden = true;
    root.classList.remove('pr-menu--closing');
  }, CLOSE_MS);
}
