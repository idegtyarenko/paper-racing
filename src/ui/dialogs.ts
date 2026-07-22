// Overlay modal dialogs: name entry (create a race / join via link), join by
// code, and short popup notifications (toasts). The DOM sheets live in #overlay.

import { bindTap, openSheet, closeOverlay } from './dom';
import { strings } from '../i18n';

const nameDialog = document.getElementById('nameDialog')!;
const nameInput = document.getElementById('nameInput') as HTMLInputElement;
const nameConfirm = document.getElementById('nameConfirm') as HTMLButtonElement;
const joinDialog = document.getElementById('joinDialog')!;
const joinCodeInput = document.getElementById('joinCodeInput') as HTMLInputElement;
const joinNameInput = document.getElementById('joinNameInput') as HTMLInputElement;
const joinError = document.getElementById('joinError')!;
const joinConfirm = document.getElementById('joinConfirm') as HTMLButtonElement;
const toast = document.getElementById('toast')!;
const connBanner = document.getElementById('connBanner')!;

// Confirm callbacks for the name/code dialogs (set when the dialog is opened).
let nameCb: ((name: string) => void) | null = null;
let joinCb: ((code: string, name: string) => void) | null = null;

/** Name-entry dialog (creating a race / joining via a link). */
export function openNameDialog(
  confirmLabel: string,
  defaultName: string,
  onConfirm: (name: string) => void,
): void {
  nameConfirm.textContent = confirmLabel;
  nameInput.value = defaultName;
  nameInput.classList.remove('field--invalid');
  nameCb = onConfirm;
  openSheet(nameDialog);
  setTimeout(() => nameInput.focus(), 50);
}

/** Flag a field as empty-but-required (red outline) and focus it, if it's the
 *  first empty field found. The outline clears as soon as the user types. */
function flagEmpty(field: HTMLInputElement, focusFirst: boolean): void {
  field.classList.add('field--invalid');
  if (focusFirst) field.focus();
}

function submitName(): void {
  const v = nameInput.value.trim();
  if (!v) {
    flagEmpty(nameInput, true);
    return;
  }
  const cb = nameCb;
  closeOverlay();
  cb?.(v);
}

/** Join-by-code dialog (code + name). The overlay doesn't close itself — the caller does. */
export function openJoinDialog(
  defaultName: string,
  defaultCode: string,
  onConfirm: (code: string, name: string) => void,
): void {
  joinCodeInput.value = defaultCode;
  joinNameInput.value = defaultName;
  joinCodeInput.classList.remove('field--invalid');
  joinNameInput.classList.remove('field--invalid');
  joinError.hidden = true;
  setJoinBusy(false);
  joinCb = onConfirm;
  openSheet(joinDialog);
  setTimeout(() => (defaultCode ? joinNameInput : joinCodeInput).focus(), 50);
}

/** While the join request is in flight: disable the button and show "Connecting…"
 *  so repeated taps don't spawn parallel join attempts. */
export function setJoinBusy(busy: boolean): void {
  joinConfirm.disabled = busy;
  joinConfirm.textContent = busy ? strings.online.joining : strings.online.joinSubmit;
}

function submitJoin(): void {
  const code = joinCodeInput.value.trim().toUpperCase();
  const name = joinNameInput.value.trim();
  if (!code || !name) {
    if (!code) flagEmpty(joinCodeInput, true);
    if (!name) flagEmpty(joinNameInput, !!code);
    return;
  }
  joinError.hidden = true;
  joinCb?.(code, name);
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
  bindTap(nameConfirm, submitName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitName();
  });
  bindTap(joinConfirm, submitJoin);
  joinNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitJoin();
  });
  // Clear the red outline as soon as the field receives input.
  for (const f of [nameInput, joinCodeInput, joinNameInput]) {
    f.addEventListener('input', () => f.classList.remove('field--invalid'));
  }
}
