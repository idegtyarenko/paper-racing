// Full-bleed editor chrome (Blueprint redesign): the floating overlays that sit
// over the board while drawing a track — a top strip (burger + step title +
// 4-segment progress), a coach-mark that travels between steps, and a bottom
// action bar. Built here (its owner module) and mounted into .app__board on
// first show, rather than living statically in index.html.
//
// The existing wizard buttons (#editButtons: next/back/join) are re-parented
// into the bottom bar — their handlers (wired in panel.ts via bindTap) and
// their per-step visibility/labels (updatePanel's edit branch) keep working
// unchanged; only their container and styling move here.

import { EditorState, EditorStep } from '../model/editor';
import { Phase } from '../app-state';
import { strings } from '../i18n';
import { showToast } from './dialogs';

const board = document.querySelector('.app__board')!;

/** Wizard step → progress index (1..4); `ready`/errors have none. */
const STEP_NUM: Partial<Record<EditorStep, number>> = {
  center: 1,
  adjust: 2,
  finish: 3,
  direction: 4,
};
const STEP_TOTAL = 4;

export interface ChromeHandlers {
  /** Open the global (burger) menu. */
  onBurger: () => void;
}

let handlers: ChromeHandlers;
let root: HTMLElement;
let titleEl: HTMLElement;
let counterEl: HTMLElement;
let segEls: HTMLElement[] = [];
let coachEl: HTMLElement;
let coachTextEl: HTMLElement;
let built = false;
/** Last error surfaced as a toast, so we don't re-toast on every re-render. */
let lastErrorToast = '';

function el(tag: string, cls: string, parent?: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (parent) parent.append(e);
  return e;
}

/** An inline SVG icon (paths pre-composed). */
function icon(cls: string, inner: string, parent: HTMLElement): HTMLElement {
  const span = el('span', cls, parent);
  span.innerHTML = inner;
  return span;
}

const BURGER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
const PEN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

function build(): void {
  root = el('div', 'pr-edit');
  root.hidden = true;

  // ── Top strip: burger + title/counter + progress ──────────────────────────
  const top = el('div', 'pr-edit__top', root);
  const burger = el('button', 'pr-edit__burger', top) as HTMLButtonElement;
  burger.type = 'button';
  burger.setAttribute('aria-label', strings.buttons.rulesTitle);
  icon('pr-edit__burger-ico', BURGER_SVG, burger);
  burger.addEventListener('click', () => handlers.onBurger());

  const head = el('div', 'pr-edit__head', top);
  const titleRow = el('div', 'pr-edit__titlerow', head);
  titleEl = el('span', 'pr-edit__title', titleRow);
  counterEl = el('span', 'pr-edit__counter', titleRow);
  const progress = el('div', 'pr-edit__progress', head);
  segEls = [];
  for (let i = 0; i < STEP_TOTAL; i++) segEls.push(el('span', 'pr-edit__seg', progress));

  // ── Coach-mark (travels between steps) ─────────────────────────────────────
  coachEl = el('div', 'pr-coach', root);
  icon('pr-coach__ico', PEN_SVG, coachEl);
  coachTextEl = el('span', 'pr-coach__text', coachEl);

  // ── Bottom action bar: re-home the existing wizard buttons ─────────────────
  const bar = el('div', 'pr-edit__bar', root);
  const editButtons = document.getElementById('editButtons');
  if (editButtons) bar.append(editButtons); // keeps their handlers/visibility logic

  board.append(root);
  built = true;
}

export function initEditorChrome(h: ChromeHandlers): void {
  handlers = h;
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

  // The coach anchors to the relevant zone per step (draw = bottom; the later
  // steps sit higher, toward the track feature being adjusted). The move itself
  // is the attention cue (CSS transition on .pr-coach).
  root.dataset.step = step;

  if (editor.error) {
    // Surface the failure as a toast once; keep the coach on the step's normal
    // instruction (the board resets to a clean draw on a self-cross).
    if (editor.message !== lastErrorToast) {
      showToast(editor.message);
      lastErrorToast = editor.message;
    }
    coachTextEl.textContent = strings.editor.step[step] ?? editor.message;
  } else {
    lastErrorToast = '';
    coachTextEl.textContent = editor.message;
  }
}
