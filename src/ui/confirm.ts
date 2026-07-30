// Generic confirmation dialog (e.g. for retiring from a race). Owns its own
// DOM: builds a shared .pr-sheet and mounts it into #overlay on first call —
// there's no markup for it in index.html (we keep index.html lean, see roadmap).

import { bindTap, openSheet, closeOverlay } from './dom';
import { button, buildSheet } from './pr-chrome';
import { strings } from '../i18n';

let sheet: HTMLElement | null = null;
let titleEl: HTMLElement;
let yesBtn: HTMLButtonElement;
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

  const cancel = button('pr-btn', s);
  cancel.textContent = strings.buttons.cancel;
  bindTap(cancel, closeOverlay);
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
  openSheet(sheet);
}
