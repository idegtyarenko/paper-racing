// Overlay modal dialogs: the rules sheet and joining by code, plus short popup
// notifications (toasts). The DOM sheets live in #overlay. Names are no longer asked for here —
// since the lobby redesign a racer types their name into their own roster row, so
// nothing stands between "play online" and a room.

import { bindTap, openSheet } from './dom';
import { strings } from '../i18n';

const rulesSheet = document.getElementById('rulesSheet')!;
const joinDialog = document.getElementById('joinDialog')!;
const joinCodeInput = document.getElementById('joinCodeInput') as HTMLInputElement;
const joinError = document.getElementById('joinError')!;
const joinConfirm = document.getElementById('joinConfirm') as HTMLButtonElement;
const toast = document.getElementById('toast')!;
const connBanner = document.getElementById('connBanner')!;

// Confirm callback for the join dialog (set when the dialog is opened).
let joinCb: ((code: string) => void) | null = null;

/** "How to play" — reached from the global menu. */
export function openRules(): void {
  openSheet(rulesSheet);
}

/** Flag a field as empty-but-required (red outline) and focus it. The outline
 *  clears as soon as the user types. */
function flagEmpty(field: HTMLInputElement): void {
  field.classList.add('field--invalid');
  field.focus();
}

/** Join-by-code dialog. The overlay doesn't close itself — the caller does. */
export function openJoinDialog(
  defaultCode: string,
  onConfirm: (code: string) => void,
): void {
  joinCodeInput.value = defaultCode;
  joinCodeInput.classList.remove('field--invalid');
  joinError.hidden = true;
  setJoinBusy(false);
  joinCb = onConfirm;
  openSheet(joinDialog);
  setTimeout(() => joinCodeInput.focus(), 50);
}

/** While the join request is in flight: disable the button and show "Connecting…"
 *  so repeated taps don't spawn parallel join attempts. */
export function setJoinBusy(busy: boolean): void {
  joinConfirm.disabled = busy;
  joinConfirm.textContent = busy ? strings.online.joining : strings.online.joinSubmit;
}

function submitJoin(): void {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!code) {
    flagEmpty(joinCodeInput);
    return;
  }
  joinError.hidden = true;
  joinCb?.(code);
}

/** Show an error in the join dialog (without closing it). */
export function showJoinError(msg: string): void {
  joinError.textContent = msg;
  joinError.hidden = false;
}

/** Show/hide the "connection lost" banner (realtime channel dropped). */
export function setConnBanner(lost: boolean): void {
  connBanner.hidden = !lost;
}

let toastTimer: number | undefined;

/** Short popup notification (link/code copied, etc.). */
export function showToast(msg: string, ms = 1800): void {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), ms);
}

/** Wire up dialog confirmation (buttons + Enter in input fields). */
export function bindDialogs(): void {
  bindTap(joinConfirm, submitJoin);
  joinCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitJoin();
  });
  // Clear the red outline as soon as the field receives input.
  joinCodeInput.addEventListener('input', () =>
    joinCodeInput.classList.remove('field--invalid'),
  );
}
