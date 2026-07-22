// Generic confirmation dialog (e.g. for retiring from a race). Owns its own
// DOM: builds a .sheet and mounts it into #overlay on first call — there's no
// markup for it in index.html (we keep index.html lean, see roadmap).

import { bindTap, openSheet, closeOverlay } from './dom';
import { strings } from '../i18n';

let sheet: HTMLElement | null = null;
let titleEl: HTMLElement;
let yesBtn: HTMLButtonElement;
let onYes: () => void = () => {};

/** Build the confirmation sheet and mount it into the overlay (once). */
function build(): HTMLElement {
  const overlay = document.getElementById('overlay')!;
  const s = document.createElement('div');
  s.className = 'sheet';
  s.hidden = true;

  titleEl = document.createElement('h2');
  titleEl.className = 'sheet__title';

  yesBtn = document.createElement('button');
  yesBtn.type = 'button';
  yesBtn.className = 'button button--center';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button button--center';
  cancel.textContent = strings.buttons.cancel;

  s.append(titleEl, yesBtn, cancel);
  overlay.append(s);
  bindTap(yesBtn, () => {
    closeOverlay();
    onYes();
  });
  bindTap(cancel, closeOverlay);
  return s;
}

/** Open the dialog: title, confirm-button label, and the "yes" callback.
 *  The confirm button defaults to the dangerous (red) style, for destructive
 *  actions like retiring; pass danger:false for positive actions (e.g.
 *  "Back to the race"). */
export function openConfirm(
  title: string,
  confirmLabel: string,
  onConfirm: () => void,
  opts: { danger?: boolean } = {},
): void {
  if (!sheet) sheet = build();
  titleEl.textContent = title;
  yesBtn.textContent = confirmLabel;
  yesBtn.classList.toggle('button--danger', opts.danger !== false);
  onYes = onConfirm;
  openSheet(sheet);
}
