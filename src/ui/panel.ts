// The side panel, now down to the track editor: its status line and the wizard
// buttons (which editor-chrome.ts re-parents into its own bottom bar). Every
// other screen has become floating Blueprint chrome with its own owner module —
// setup and both lobbies (ui/setup-chrome.ts, ui/online-lobby.ts), the live race
// (ui/race-chrome.ts) and the result screen (ui/race-result.ts).
//
// bindButtons is still the single place where the app's static buttons get
// their handlers, which is why the confirm-move and skip buttons are wired here
// even though the race chrome owns where they sit.

import { Phase } from '../app-state';
import { EditorState, EditorStep, canStepBack } from '../model/editor';
import { strings } from '../i18n';
import { bindTap, openSheet, bindOverlayClose } from './dom';
import { div, renderStepStatus, statusElement } from './status';
import { bindDialogs } from './dialogs';

const statusEl = statusElement();

const editButtons = document.getElementById('editButtons')!;
const backBtn = document.getElementById('backBtn') as HTMLButtonElement;
const nextBtn = document.getElementById('nextBtn') as HTMLButtonElement;
const helpBtn = document.getElementById('helpBtn') as HTMLButtonElement;
const confirmMoveBtn = document.getElementById('confirmMove') as HTMLButtonElement;
const skipBtn = document.getElementById('skipTurn') as HTMLButtonElement;
const rulesSheet = document.getElementById('rulesSheet')!;

// The editor's join-by-code button (shown on the drawing step only).
const joinByCodeBtn = document.getElementById('joinByCode') as HTMLButtonElement;

export interface PanelHandlers {
  /** Step back in the track editor. */
  onBack: () => void;
  /** Confirm the edges (adjust phase) and move on to start/finish placement. */
  onNext: () => void;
  onConfirmMove: () => void;
  /** Open the join-by-code dialog (from the drawing screen). */
  onJoinByCode: () => void;
  /** Skip the turn of a player who's stalling (their car coasts on its momentum). */
  onSkip: () => void;
}

/** Whether the online backend is configured: without it, "Join by code" is always hidden. */
let onlineEnabled = false;

/** Hide online entry points if the backend isn't configured (local play only). */
export function setOnlineEnabled(enabled: boolean): void {
  onlineEnabled = enabled;
  joinByCodeBtn.hidden = true; // shown only on the editor's first step (see update)
}

export function bindButtons(h: PanelHandlers): void {
  bindTap(backBtn, h.onBack);
  bindTap(nextBtn, h.onNext);
  bindTap(confirmMoveBtn, h.onConfirmMove);
  bindTap(joinByCodeBtn, h.onJoinByCode);
  bindTap(skipBtn, h.onSkip);
  bindTap(helpBtn, () => openSheet(rulesSheet));
  bindDialogs();
  bindOverlayClose();
}

// Wizard step number for the "step N of 4" badge, keyed by phase. `ready` and
// errors have no badge (the message renders as plain body text). Locale-independent:
// the badge is built from strings.editor.stepBadge rather than parsed out of
// text (there used to be a regex here for that).
const EDIT_STEP: Partial<Record<EditorStep, number>> = {
  center: 1,
  adjust: 2,
  finish: 3,
  direction: 4,
};
const EDIT_STEP_TOTAL = 4;

/** Render the editor's message: a prominent "step N of 4" badge + instruction. */
function renderEditStatus(editor: EditorState): void {
  statusEl.className = 'status';
  if (editor.error) {
    statusEl.classList.add('status--error');
    statusEl.textContent = editor.message;
    return;
  }
  const step = EDIT_STEP[editor.step];
  if (step !== undefined) {
    renderStepStatus(strings.editor.stepBadge(step, EDIT_STEP_TOTAL), editor.message);
  } else {
    statusEl.classList.add('status--step');
    statusEl.replaceChildren(div('status__body', editor.message));
  }
}

export interface PanelCtx {
  phase: Phase;
  editor: EditorState;
}

export function updatePanel(ctx: PanelCtx): void {
  const { phase, editor } = ctx;
  const editing = phase === 'edit';
  editButtons.hidden = !editing;
  if (!editing) {
    // Every other phase is owned by a floating screen, which hides the panel via
    // its body class. Leave nothing stale behind for the next visit here.
    statusEl.className = 'status';
    statusEl.textContent = '';
    return;
  }

  renderEditStatus(editor);
  backBtn.disabled = !canStepBack(editor);
  // On step 2, "← Back" erases the whole drawn track — name the action honestly.
  backBtn.textContent =
    editor.step === 'adjust' ? strings.buttons.redraw : strings.buttons.back;
  // Next advances adjust → finish → direction; the finish and direction steps
  // are auto-placed/pre-selected, so they confirm with an explicit button. On
  // the last step it becomes "Choose mode" (leaves the editor for setup).
  nextBtn.hidden = !['adjust', 'finish', 'direction'].includes(editor.step);
  nextBtn.textContent =
    editor.step === 'direction' ? strings.buttons.chooseMode : strings.buttons.next;
  // "Join by code" only makes sense on the first step; later in the wizard it's just in the way.
  joinByCodeBtn.hidden = !onlineEnabled || editor.step !== 'center';
}
