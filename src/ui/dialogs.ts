// Overlay modal dialogs: the rules sheet and joining by code, plus short popup
// notifications (toasts). Both sheets are built here, their owner module, on
// first open — index.html carries only the empty #overlay they mount into.
// Names are no longer asked for here: since the lobby redesign a racer types
// their name into their own roster row, so nothing stands between "play online"
// and a room.

import { bindTap, closeOverlay, openSheet } from './dom';
import { button, buildSheet, el, icon } from './pr-chrome';
import { strings } from '../i18n';
import { WARN_SVG } from './icons';

const toast = document.getElementById('toast')!;
// The failure skin's warning mark. It lives in markup rather than a CSS
// ::before so it inherits currentColor like every other icon — content: url()
// would not — and the toast's own text node is rebuilt around it per message.
const toastIcon = icon('pr-toast__ico', WARN_SVG, toast);
const toastText = el('span', 'pr-toast__text', toast);
const connBanner = document.getElementById('connBanner')!;
connBanner.textContent = strings.online.reconnecting;

// ── Rules ("how to play") ───────────────────────────────────────────────────

let rulesSheet: HTMLElement | null = null;
let versionEl: HTMLElement | null = null;

/** Build label ("<commit> · <date>"), shown at the foot of the rules sheet and
 *  read back by the global menu for its footer. */
let version = '';
/** Five quick taps on the build label toggle the SW debug overlay (see main.ts). */
let onVersionTaps: () => void = () => {};

function buildRules(): HTMLElement {
  const sheet = buildSheet(strings.buttons.rulesTitle);
  el('p', 'pr-sheet__text', sheet).textContent = strings.rules.body;
  const close = button('pr-btn', sheet);
  close.textContent = strings.buttons.toWheel;
  bindTap(close, closeOverlay);
  versionEl = el('p', 'pr-sheet__version', sheet);
  versionEl.setAttribute('aria-hidden', 'true');
  versionEl.textContent = version;
  bindVersionTaps(versionEl);
  return sheet;
}

/** "How to play" — reached from the global menu. */
export function openRules(): void {
  if (!rulesSheet) rulesSheet = buildRules();
  openSheet(rulesSheet);
}

/**
 * Publish the build label. Called at startup, long before the sheet that shows
 * it exists — hence a value here rather than a node in index.html that both
 * main.ts and the menu had to scrape text out of. `onTaps` fires on five quick
 * taps on the label.
 */
export function setVersionLabel(label: string, onTaps: () => void): void {
  version = label;
  onVersionTaps = onTaps;
  if (versionEl) versionEl.textContent = label;
}

/** The build label, for the menu's footer. */
export function versionLabel(): string {
  return version;
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

// ── Join by code ────────────────────────────────────────────────────────────

let joinSheet: HTMLElement | null = null;
let joinCodeInput: HTMLInputElement;
let joinError: HTMLElement;
let joinConfirm: HTMLButtonElement;

// Confirm callback for the join dialog (set when the dialog is opened).
let joinCb: ((code: string) => void) | null = null;

function buildJoin(): HTMLElement {
  const sheet = buildSheet(strings.online.joinTitle);

  joinCodeInput = el('input', 'pr-field pr-field--code', sheet);
  joinCodeInput.type = 'text';
  joinCodeInput.maxLength = 5;
  joinCodeInput.autocomplete = 'off';
  joinCodeInput.setAttribute('autocapitalize', 'characters');
  joinCodeInput.spellcheck = false;
  joinCodeInput.placeholder = strings.online.codePlaceholder;
  joinCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitJoin();
  });
  // Clear the red outline as soon as the field receives input.
  joinCodeInput.addEventListener('input', () =>
    joinCodeInput.classList.remove('pr-field--invalid'),
  );

  joinError = el('div', 'pr-field-error', sheet);
  joinError.hidden = true;

  joinConfirm = button('pr-btn pr-btn--primary pr-btn--caps', sheet);
  bindTap(joinConfirm, submitJoin);

  const cancel = button('pr-btn', sheet);
  cancel.textContent = strings.buttons.cancel;
  bindTap(cancel, closeOverlay);
  return sheet;
}

/** Join-by-code dialog. The overlay doesn't close itself — the caller does. */
export function openJoinDialog(
  defaultCode: string,
  onConfirm: (code: string) => void,
): void {
  if (!joinSheet) joinSheet = buildJoin();
  joinCodeInput.value = defaultCode;
  joinCodeInput.classList.remove('pr-field--invalid');
  joinError.hidden = true;
  setJoinBusy(false);
  joinCb = onConfirm;
  openSheet(joinSheet);
  setTimeout(() => joinCodeInput.focus(), 50);
}

/** While the join request is in flight: disable the button and show "Connecting…"
 *  so repeated taps don't spawn parallel join attempts. */
export function setJoinBusy(busy: boolean): void {
  if (!joinSheet) return;
  joinConfirm.disabled = busy;
  joinConfirm.textContent = busy ? strings.online.joining : strings.online.joinSubmit;
}

function submitJoin(): void {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!code) {
    // Empty but required — red outline, and put the caret back in the field.
    joinCodeInput.classList.add('pr-field--invalid');
    joinCodeInput.focus();
    return;
  }
  joinError.hidden = true;
  joinCb?.(code);
}

/** Show an error in the join dialog (without closing it). */
export function showJoinError(msg: string): void {
  if (!joinSheet) return;
  joinError.textContent = msg;
  joinError.hidden = false;
}

// ── Transient chrome ────────────────────────────────────────────────────────

/** Show/hide the "connection lost" banner (realtime channel dropped). */
export function setConnBanner(lost: boolean): void {
  connBanner.hidden = !lost;
}

let toastTimer: number | undefined;

function raiseToast(msg: string, ms: number, error: boolean): void {
  toastText.textContent = msg;
  // The skin follows the message's meaning, not the screen it lands on: the
  // "app updated" notice used to look like a crash purely because it arrives
  // while the editor is still open.
  toast.classList.toggle('pr-toast--error', error);
  toastIcon.hidden = !error;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), ms);
}

/** Short popup notification (link/code copied, an update installed, etc.). */
export function showToast(msg: string, ms = 1800): void {
  raiseToast(msg, ms, false);
}

/** Same popup in the red warning skin — for a failure, not for news the player
 *  merely needs to see. */
export function showErrorToast(msg: string, ms = 1800): void {
  raiseToast(msg, ms, true);
}
