// Full-bleed editor chrome (Blueprint redesign): the floating overlays that sit
// over the board while drawing a track — a top strip (burger + step title +
// 4-segment progress), a coach-mark that travels between steps, and a bottom
// action bar. Built here (its owner module) and mounted into .app__board on
// first show, rather than living statically in index.html. The burger opens the
// global menu, which owns itself (menu.ts).
//
// The existing wizard buttons (#editButtons: next/back/join) are re-parented
// into the bottom bar — their handlers (wired in panel.ts via bindTap) and
// their per-step visibility/labels (updatePanel's edit branch) keep working
// unchanged; only their container and styling move here.

import { EditorState, EditorStep } from '../model/editor';
import { Phase } from '../app-state';
import { strings } from '../i18n';
import { showToast } from './dialogs';
import { el, button, icon, buildTopbar, buildBrand, BURGER_SVG } from './pr-chrome';
import { openMenu } from './menu';

const board = document.querySelector('.app__board')!;

/** Wizard step → progress index (1..4); `ready`/errors have none. */
const STEP_NUM: Partial<Record<EditorStep, number>> = {
  center: 1,
  adjust: 2,
  finish: 3,
  direction: 4,
};
const STEP_TOTAL = 4;
/** Wizard steps in order — for the wide-screen rail's numbered list. */
const STEP_ORDER: EditorStep[] = ['center', 'adjust', 'finish', 'direction'];

let root: HTMLElement;
let titleEl: HTMLElement;
let counterEl: HTMLElement;
let segEls: HTMLElement[] = [];
let coachEl: HTMLElement;
let coachTextEl: HTMLElement;
let built = false;
/** Last error surfaced as a toast, so we don't re-toast on every re-render. */
let lastErrorToast = '';

/** Coach-mark bullet — the amber ✎ glyph from the hi-fi (not a drawn pencil). */
const PEN_GLYPH = '✎';

function build(): void {
  root = el('div', 'pr-layer pr-edit');
  root.hidden = true;

  // ── Top bar (shared component) + the editor's own counter and progress ────
  const top = buildTopbar(root, {
    iconSvg: BURGER_SVG,
    label: strings.menu.title,
    onTap: openMenu,
  });
  top.root.classList.add('pr-edit__top');
  // The title sits in a row with the "step N of 4" counter, so it moves into a
  // row wrapper inside the shared head.
  const titleRow = el('div', 'pr-edit__titlerow');
  top.head.prepend(titleRow);
  titleRow.append(top.title);
  titleEl = top.title;
  counterEl = el('span', 'pr-edit__counter', titleRow);
  const progress = el('div', 'pr-edit__progress', top.head);
  segEls = [];
  for (let i = 0; i < STEP_TOTAL; i++) segEls.push(el('span', 'pr-edit__seg', progress));

  // ── Coach-mark (travels between steps) ─────────────────────────────────────
  coachEl = el('div', 'pr-card pr-card--lg pr-card--solid pr-coach', root);
  el('span', 'pr-coach__ico', coachEl).textContent = PEN_GLYPH;
  coachTextEl = el('span', 'pr-coach__text', coachEl);

  // ── Wide-screen rail: step list + coach (replaces the top strip ≥700px).
  //    Static structure; renderRail() updates the active row + coach text. ─────
  const rail = el('div', 'pr-edit__rail', root);
  // Header row: brand + the burger, which is the menu's only entry point here
  // (the mobile top strip is hidden at this width).
  const railHead = el('div', 'pr-edit__rail-head', rail);
  buildBrand(railHead, { cls: 'pr-brand--sm', dashes: 6 });
  const railBurger = button('pr-btn pr-btn--icon pr-edit__rail-burger', railHead);
  railBurger.setAttribute('aria-label', strings.menu.title);
  icon('pr-btn__ico', BURGER_SVG, railBurger);
  railBurger.addEventListener('click', openMenu);
  el('div', 'pr-label pr-edit__rail-title', rail);
  const railSteps = el('div', 'pr-edit__rail-steps', rail);
  STEP_ORDER.forEach((step, i) => {
    const row = el('div', 'pr-edit__rail-step', railSteps);
    el('span', 'pr-edit__rail-num', row).textContent = String(i + 1);
    el('span', 'pr-edit__rail-label', row).textContent =
      strings.editor.stepTitle[step] ?? '';
  });
  const railCoach = el('div', 'pr-card pr-card--solid pr-edit__rail-coach', rail);
  el('span', 'pr-coach__ico', railCoach).textContent = PEN_GLYPH;
  el('span', 'pr-edit__rail-coach-text', railCoach);

  // ── Bottom action bar: re-home the existing wizard buttons ─────────────────
  // They keep their ids/handlers/visibility logic and only gain the shared
  // Blueprint button classes (which outrank the cream `.button` rules).
  const bar = el('div', 'pr-edit__bar', root);
  const editButtons = document.getElementById('editButtons');
  if (editButtons) {
    bar.append(editButtons);
    // Queried inside the wrapper, not by id: it has just been detached from the
    // document (root is mounted at the end of build), so getElementById would
    // find nothing.
    const skin = (id: string, cls: string): void =>
      editButtons.querySelector('#' + id)?.classList.add(...cls.split(' '));
    skin('nextBtn', 'pr-btn pr-btn--primary');
    skin('backBtn', 'pr-btn');
    skin('joinByCode', 'pr-btn pr-btn--caps');
  }

  board.append(root);
  built = true;
}

export function initEditorChrome(): void {
  build();
}

/**
 * Render the editor chrome for the current state. Shows the chrome (and hides
 * the side panel via body.is-editing) only in the edit phase. Errors surface as
 * a toast (design 3E) while the coach-mark keeps the step's normal instruction.
 */
export function renderEditorChrome(editor: EditorState, phase: Phase): void {
  if (!built) return;
  const editing = phase === 'edit';
  root.hidden = !editing;
  document.body.classList.toggle('is-editing', editing);
  if (!editing) {
    lastErrorToast = '';
    delete document.body.dataset.editStep;
    return;
  }

  const step = editor.step;
  const n = STEP_NUM[step];
  titleEl.textContent = strings.editor.stepTitle[step] ?? '';
  counterEl.textContent = n ? strings.editor.stepCounter(n, STEP_TOTAL) : '';
  segEls.forEach((seg, i) => {
    seg.classList.toggle('pr-edit__seg--done', n !== undefined && i + 1 < n);
    seg.classList.toggle('pr-edit__seg--active', n !== undefined && i + 1 === n);
  });

  renderRail(step, n);

  // The coach anchors to the relevant zone per step (draw = bottom; the later
  // steps sit higher, toward the track feature being adjusted). The move itself
  // is the attention cue (CSS transition on .pr-coach). `data-edit-step` on the
  // body drives the per-step canvas cursor (draw = ring+dot).
  root.dataset.step = step;
  document.body.dataset.editStep = step;

  let coachText: string;
  if (editor.error) {
    // Surface the failure as a toast (auto-dismisses; longer than the default so
    // the longer RU/BE strings are readable) once; keep the coach on the step's
    // normal instruction (the board resets to a clean draw on a self-cross).
    if (editor.message !== lastErrorToast) {
      showToast(editor.message, 3200);
      lastErrorToast = editor.message;
    }
    coachText = strings.editor.step[step] ?? editor.message;
  } else {
    lastErrorToast = '';
    coachText = editor.message;
  }
  coachTextEl.textContent = coachText;
  root.querySelector<HTMLElement>('.pr-edit__rail-coach-text')!.textContent = coachText;
}

/** Update the wide-screen rail's header + active/done rows. The rail is static
 *  structure built once, so its nodes are queried here rather than cached. */
function renderRail(step: EditorStep, n: number | undefined): void {
  root.querySelector<HTMLElement>('.pr-edit__rail-title')!.textContent =
    strings.editor.stepTitle[step] ?? '';
  root.querySelectorAll<HTMLElement>('.pr-edit__rail-step').forEach((row, i) => {
    row.classList.toggle('pr-edit__rail-step--done', n !== undefined && i + 1 < n);
    row.classList.toggle('pr-edit__rail-step--active', n !== undefined && i + 1 === n);
  });
}
