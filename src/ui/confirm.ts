// Generic confirmation dialog (e.g. for retiring from a race). Owns its own
// DOM: builds a shared .pr-sheet and mounts it into #overlay on first call —
// there's no markup for it in index.html (we keep index.html lean, see roadmap).

import { bindTap, openSheet, closeOverlay } from './dom';
import { button, buildSheet } from './pr-chrome';
import { strings } from '../i18n';

let sheet: HTMLElement | null = null;
let titleEl: HTMLElement;
let yesBtn: HTMLButtonElement;
let cancelBtn: HTMLButtonElement;
let onYes: () => void = () => {};

/** Build the confirmation sheet and mount it into the overlay (once). */
function build(): HTMLElement {
  const s = buildSheet('');
  titleEl = s.querySelector('.pr-sheet__title')!;

  yesBtn = button('pr-btn pr-btn--caps', s);
  bindTap(yesBtn, () => {
    closeOverlay();
    onYes();
  });

  cancelBtn = button('pr-btn', s);
  cancelBtn.textContent = strings.buttons.cancel;
  bindTap(cancelBtn, closeOverlay);
  return s;
}

/** Open the dialog: title, confirm-button label, and the "yes" callback.
 *  The confirm button defaults to the dangerous (red) style, for destructive
 *  actions like retiring; pass danger:false for positive actions (e.g.
 *  "Back to the race"), which get the normal amber primary instead. */
export function openConfirm(
  title: string,
  confirmLabel: string,
  onConfirm: () => void,
  opts: { danger?: boolean } = {},
): void {
  if (!sheet) sheet = build();
  const danger = opts.danger !== false;
  titleEl.textContent = title;
  yesBtn.textContent = confirmLabel;
  yesBtn.classList.toggle('pr-btn--danger', danger);
  yesBtn.classList.toggle('pr-btn--primary', !danger);
  onYes = onConfirm;
  cancelBtn.hidden = false;
  openSheet(sheet);
}

/**
 * Same sheet, one button: news the player can only acknowledge (the race can't go on),
 * not a choice. "Cancel" would offer a way to stay in a situation there's no staying in,
 * so it's dropped — the overlay can still be dismissed, and the news comes back the next
 * time anything happens in the room.
 */
export function openNotice(title: string, okLabel: string, onOk: () => void): void {
  if (!sheet) sheet = build();
  titleEl.textContent = title;
  yesBtn.textContent = okLabel;
  yesBtn.classList.remove('pr-btn--danger');
  yesBtn.classList.add('pr-btn--primary');
  onYes = onOk;
  cancelBtn.hidden = true;
  openSheet(sheet);
}
