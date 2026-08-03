// Full-bleed editor chrome (Blueprint redesign): the floating overlays that sit
// over the board while drawing a track — a coach-mark that travels between
// steps and a bottom action bar with the wizard's Back / Next / Join buttons.
// Built here (its owner module) and mounted into .app__board on first show,
// rather than living statically in index.html.
//
// The step title, counter and progress are no longer the editor's business:
// drawing is steps 1–4 of a six-step run-up to a race, so the top strip and the
// wide-screen rail live in wizard-nav.ts, which spans all six. The editor only
// hands that rail its coach card (the instruction for the current step).

import { EditorState, canStepBack } from '../model/editor';
import { Phase } from '../app-state';
import { strings } from '../i18n';
import { showErrorToast } from './dialogs';
import { bindTap } from './dom';
import {
  ARROW_SVG,
  button,
  el,
  icon,
  GLOBE_SVG,
  PENCIL_SVG,
  UNDO_SVG,
} from './pr-chrome';
import { wizardNavFoot } from './wizard-nav';

const board = document.querySelector('.app__board')!;

let root: HTMLElement;
let coachEl: HTMLElement;
let coachTextEl: HTMLElement;
let railCoachEl: HTMLElement;
let railCoachTextEl: HTMLElement;
let backBtn: HTMLButtonElement;
let backIcoEl: HTMLElement;
let backTextEl: HTMLElement;
let nextBtn: HTMLButtonElement;
let nextTextEl: HTMLElement;
let joinBtn: HTMLButtonElement;
let built = false;
/** Last error surfaced as a toast, so we don't re-toast on every re-render. */
let lastErrorToast = '';

/** Whether the online backend is configured: without it, "Join by code" never shows. */
let onlineEnabled = false;

export interface EditorChromeHandlers {
  /** Step back in the track editor (on step 2 this redraws from scratch). */
  onBack: () => void;
  /** Confirm the current step and move on; on the last one, leave for mode select. */
  onNext: () => void;
  /** Open the join-by-code dialog (offered on the drawing step only). */
  onJoinByCode: () => void;
}

function build(h: EditorChromeHandlers): void {
  root = el('div', 'pr-layer pr-edit');
  root.hidden = true;

  // ── Coach-mark (travels between steps) ─────────────────────────────────────
  coachEl = el('div', 'pr-card pr-card--lg pr-card--solid pr-coach', root);
  icon('pr-coach__ico', PENCIL_SVG, coachEl);
  coachTextEl = el('span', 'pr-coach__text', coachEl);

  // ── The same instruction for wide screens: a card in the step rail's bottom
  //    slot, which wizard-nav.ts owns (the floating coach is phone-only). ─────
  railCoachEl = el('div', 'pr-card pr-card--solid pr-edit__rail-coach', wizardNavFoot());
  icon('pr-coach__ico', PENCIL_SVG, railCoachEl);
  railCoachTextEl = el('span', 'pr-edit__rail-coach-text', railCoachEl);

  // ── Bottom action bar: the wizard's three buttons ──────────────────────────
  // Labels and per-step visibility are set by renderBar() on every render.
  const bar = el('div', 'pr-edit__bar', root);
  backBtn = button('pr-btn pr-edit__back', bar);
  // Two labels share this button (see renderBar): only "Redraw" — which wipes
  // the drawn track — carries the circular arrow, so the icon is hidden rather
  // than rebuilt when it goes back to being a plain "Back".
  backIcoEl = icon('pr-edit__back-ico', UNDO_SVG, backBtn);
  backTextEl = el('span', 'pr-edit__back-text', backBtn);
  bindTap(backBtn, h.onBack);
  nextBtn = button('pr-btn pr-btn--primary pr-edit__next', bar);
  // Text first, arrow after it: the label used to end in a "→" and the button
  // reads as "forward", so the mark stays on the trailing edge.
  nextTextEl = el('span', 'pr-edit__next-text', nextBtn);
  icon('pr-edit__next-ico', ARROW_SVG, nextBtn);
  bindTap(nextBtn, h.onNext);
  joinBtn = button('pr-btn pr-btn--caps pr-edit__join', bar);
  // Plain wrapper, not .pr-btn__ico: this globe rides at the shared 16px inline
  // size (.pr-btn svg), not the 22px of a standalone icon button.
  icon('pr-edit__join-ico', GLOBE_SVG, joinBtn);
  el('span', 'pr-edit__join-text', joinBtn).textContent = strings.online.joinByCode;
  bindTap(joinBtn, h.onJoinByCode);

  board.append(root);
  built = true;
}

export function initEditorChrome(h: EditorChromeHandlers): void {
  build(h);
}

/** Hide online entry points if the backend isn't configured (local play only). */
export function setOnlineEnabled(enabled: boolean): void {
  onlineEnabled = enabled;
}

/** The action bar for the current step: which buttons apply and what they say. */
function renderBar(editor: EditorState): void {
  // Step 1 has nothing to go back to — hide the button rather than showing a
  // dead one. On step 2 "Back" erases the whole drawn track, so name it honestly.
  backBtn.hidden = !canStepBack(editor);
  const redrawing = editor.step === 'adjust';
  backIcoEl.hidden = !redrawing;
  backTextEl.textContent = redrawing ? strings.buttons.redraw : strings.buttons.back;
  // Next advances adjust → finish → direction; the finish and direction steps
  // are auto-placed/pre-selected, so they confirm with an explicit button. On
  // the last step it becomes "Choose mode" (leaves the editor for setup).
  nextBtn.hidden = !['adjust', 'finish', 'direction'].includes(editor.step);
  nextTextEl.textContent =
    editor.step === 'direction' ? strings.buttons.chooseMode : strings.buttons.next;
  // "Join by code" only makes sense on the first step; later in the wizard it's just in the way.
  joinBtn.hidden = !onlineEnabled || editor.step !== 'center';
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
  // The rail's coach card belongs to the rail, not to this layer — hide it
  // separately once the wizard moves past the drawing steps.
  railCoachEl.hidden = !editing;
  document.body.classList.toggle('is-editing', editing);
  if (!editing) {
    lastErrorToast = '';
    delete document.body.dataset.editStep;
    return;
  }

  const step = editor.step;
  // The coach anchors to the relevant zone per step (draw = bottom; the later
  // steps sit higher, toward the track feature being adjusted). The move itself
  // is the attention cue (CSS transition on .pr-coach). `data-edit-step` on the
  // body drives the per-step canvas cursor (draw = ring+dot).
  root.dataset.step = step;
  document.body.dataset.editStep = step;
  renderBar(editor);

  let coachText: string;
  if (editor.error) {
    // Surface the failure as a toast (auto-dismisses; longer than the default so
    // the longer RU/BE strings are readable) once; keep the coach on the step's
    // normal instruction (the board resets to a clean draw on a self-cross).
    if (editor.message !== lastErrorToast) {
      showErrorToast(editor.message, 3200);
      lastErrorToast = editor.message;
    }
    coachText = strings.editor.step[step] ?? editor.message;
  } else {
    lastErrorToast = '';
    coachText = editor.message;
  }
  coachTextEl.textContent = coachText;
  railCoachTextEl.textContent = coachText;
}
