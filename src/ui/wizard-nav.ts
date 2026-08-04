// Step navigation for the whole run-up to a race (Blueprint redesign): drawing
// the track (four editor steps), picking a mode, and setting the race up — six
// steps of one wizard, not two separate interfaces. This module owns both
// renderings of that progress: the phone's top strip (burger + step title +
// counter + segments) and the wide-screen left rail (brand + burger + numbered
// step list). Both used to live in editor-chrome.ts and covered only the
// drawing steps; they moved here unchanged in look, and now cover all six.
//
// Steps are not a new type: a step *is* the existing (Phase, EditorStep) pair —
// this module only turns that pair into labels and a position, and hands taps on
// already-passed rows back to main.ts (which walks back through the same
// stepBack/backFromSetup transitions the Back button uses).

import { Phase } from '../app-state';
import { EditorStep } from '../model/editor';
import { strings } from '../i18n';
import { el, button, icon, buildTopbar, buildBrand } from './pr-chrome';
import { openMenu } from './menu';
import { BURGER_SVG } from './icons';

const board = document.querySelector('.app__board')!;

/** The editor's own steps, in wizard order (`ready` is transient — no row). */
const EDIT_STEPS: EditorStep[] = ['center', 'adjust', 'finish', 'direction'];

export interface WizardNavHandlers {
  /** Tap on an already-passed step row (0-based index into the current run). */
  onJumpTo: (index: number) => void;
}

let handlers: WizardNavHandlers;
let built = false;
let root: HTMLElement;
let titleEl: HTMLElement;
let counterEl: HTMLElement;
let progressEl: HTMLElement;
let railTitleEl: HTMLElement;
let railStepsEl: HTMLElement;
let footEl: HTMLElement;
/** Active index of the previous render — used to publish the travel direction. */
let lastActive = -1;

/**
 * Labels of the steps in the current run and the index of the active one
 * (0-based; −1 when we're outside the wizard, e.g. racing).
 *
 * Coming back from a race ("new race → same track") there is nothing to draw,
 * so the run is only the two setup steps, numbered 1–2.
 */
export function wizardSteps(
  phase: Phase,
  step: EditorStep,
  playersReturn: 'edit' | 'race',
  onlineHost = false,
): { labels: string[]; active: number } {
  const none = { labels: [] as string[], active: -1 };
  const tail = [strings.wizard.stepMode, strings.wizard.stepSetup];
  if (phase === 'edit') {
    // `ready` is transient — normally we're already on mode select by the time
    // it's rendered, but a track that fails final validation stays in the editor
    // on it. Show it as the step it steps back to, not as "nowhere".
    const active = step === 'ready' ? EDIT_STEPS.length - 1 : EDIT_STEPS.indexOf(step);
    const labels = [...EDIT_STEPS.map((s) => strings.editor.stepTitle[s]), ...tail];
    return active < 0 ? none : { labels, active };
  }
  const fromRace = playersReturn === 'race';
  const labels = fromRace
    ? tail
    : [...EDIT_STEPS.map((s) => strings.editor.stepTitle[s]), ...tail];
  const base = labels.length - 2;
  if (phase === 'modeSelect') return { labels, active: base };
  if (phase === 'players' || phase === 'ai') return { labels, active: base + 1 };
  // The host's lobby IS the setup step (setup-chrome.ts renders it as one), so
  // the wizard doesn't disappear while they wait for friends. A guest's lobby is
  // a screen of its own and has no wizard behind it.
  if (phase === 'lobby' && onlineHost) return { labels, active: base + 1 };
  return none;
}

function build(): void {
  root = el('div', 'pr-layer pr-nav');
  root.hidden = true;

  // ── Phone: top strip. The bar, its icon button and the title are the shared
  //    .pr-topbar; the counter and the progress segments are ours. ────────────
  const top = buildTopbar(root, {
    iconSvg: BURGER_SVG,
    label: strings.menu.title,
    onTap: openMenu,
  });
  top.root.classList.add('pr-nav__top');
  const titleRow = el('div', 'pr-nav__titlerow');
  top.head.prepend(titleRow);
  titleRow.append(top.title);
  titleEl = top.title;
  counterEl = el('span', 'pr-nav__counter', titleRow);
  progressEl = el('div', 'pr-nav__progress', top.head);

  // ── Wide screens: the left rail. Same burger (the top strip is hidden at this
  //    width), the run's heading, and the numbered step list. ─────────────────
  const rail = el('div', 'pr-nav__rail', root);
  const railHead = el('div', 'pr-nav__rail-head', rail);
  buildBrand(railHead, { cls: 'pr-brand--sm', dashes: 6 });
  const railBurger = button('pr-btn pr-btn--icon pr-nav__rail-burger', railHead);
  railBurger.setAttribute('aria-label', strings.menu.title);
  icon('pr-btn__ico', BURGER_SVG, railBurger);
  railBurger.addEventListener('click', openMenu);
  // The rail names the run, not the step — the active row already says which
  // step we're on (the phone strip, with no list, keeps the step title).
  railTitleEl = el('div', 'pr-label pr-nav__rail-title', rail);
  railTitleEl.textContent = strings.wizard.title;
  railStepsEl = el('div', 'pr-nav__rail-steps', rail);
  // Foot of the rail: screens mount their own extras here (the editor's
  // coach-mark card). Pushed to the bottom by CSS.
  footEl = el('div', 'pr-nav__foot', rail);

  board.append(root);
  built = true;
}

export function initWizardNav(h: WizardNavHandlers): void {
  handlers = h;
  build();
}

/** The rail's bottom slot — for screens that add their own card to the rail. */
export function wizardNavFoot(): HTMLElement {
  return footEl;
}

/** Grow/shrink the segment and rail rows to match the run's length (4, 6 or 2
 *  steps), keeping existing nodes so their transitions still play. */
function syncRows(labels: string[]): void {
  while (progressEl.children.length > labels.length)
    progressEl.lastElementChild!.remove();
  while (progressEl.children.length < labels.length)
    el('span', 'pr-nav__seg', progressEl);

  while (railStepsEl.children.length > labels.length)
    railStepsEl.lastElementChild!.remove();
  while (railStepsEl.children.length < labels.length) {
    const row = button('pr-nav__rail-step', railStepsEl);
    const index = railStepsEl.children.length - 1;
    el('span', 'pr-nav__rail-num', row).textContent = String(index + 1);
    el('span', 'pr-nav__rail-label', row);
    row.addEventListener('click', () => handlers.onJumpTo(index));
  }
  labels.forEach((label, i) => {
    railStepsEl.children[i].querySelector('.pr-nav__rail-label')!.textContent = label;
  });
}

/** Render the step navigation for the current phase; hides itself outside the
 *  wizard (lobby, race), where the old panel takes over. */
export function renderWizardNav(
  phase: Phase,
  step: EditorStep,
  playersReturn: 'edit' | 'race',
  onlineHost = false,
): void {
  if (!built) return;
  const { labels, active } = wizardSteps(phase, step, playersReturn, onlineHost);
  root.hidden = active < 0;
  if (active < 0) {
    lastActive = -1;
    delete document.body.dataset.navDir;
    return;
  }

  // Which way the wizard just travelled — the hook the screen-slide transition
  // will hang off (nothing reads it yet).
  if (lastActive >= 0 && active !== lastActive) {
    document.body.dataset.navDir = active > lastActive ? 'fwd' : 'back';
  }
  lastActive = active;

  syncRows(labels);
  titleEl.textContent = labels[active];
  counterEl.textContent = strings.editor.stepCounter(active + 1, labels.length);
  Array.from(progressEl.children).forEach((seg, i) => {
    seg.classList.toggle('pr-nav__seg--done', i < active);
    seg.classList.toggle('pr-nav__seg--active', i === active);
  });
  Array.from(railStepsEl.children).forEach((row, i) => {
    row.classList.toggle('pr-nav__rail-step--done', i < active);
    row.classList.toggle('pr-nav__rail-step--active', i === active);
    // Only passed steps are tappable — the wizard is never skipped forward.
    // From the lobby nothing is: stepping back there means tearing the room
    // down, which is "Leave lobby", not a step.
    (row as HTMLButtonElement).disabled = i >= active || phase === 'lobby';
  });
}
