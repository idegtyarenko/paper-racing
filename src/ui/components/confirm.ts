// Generic confirmation dialog (e.g. for retiring from a race). Owns its own
// DOM: builds a shared .pr-sheet and mounts it into #overlay on first call —
// there's no markup for it in index.html (we keep index.html lean, see roadmap).

import { bindTap, openSheet, closeOverlay, sheetOpen } from '../primitives/dom';
import { button, buildSheet } from '../primitives/pr-chrome';
import { strings } from '../../i18n';

let sheet: HTMLElement | null = null;
let titleEl: HTMLElement;
let yesBtn: HTMLButtonElement;
let cancelBtn: HTMLButtonElement;
let onYes: () => void = () => {};
/** Title of the last notice opened, so it can be recognised on screen later. */
let noticeTitle: string | null = null;

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
  noticeTitle = title;
  cancelBtn.hidden = true;
  openSheet(sheet);
}

/**
 * Take this sheet off screen if it's the one showing — for news that has expired
 * while it was up (the creator came back, so "the bots have stopped" is no longer
 * true). Any other sheet is left alone: it belongs to something else the player
 * opened, and closing it would eat their tap.
 */
export function closeNoticeIfOpen(): void {
  // Title check, not just "the sheet is up": openConfirm reuses this very sheet, so
  // without it a notice expiring would swallow a confirmation the player had opened
  // in the meantime.
  if (sheet && sheetOpen(sheet) && titleEl.textContent === noticeTitle) closeOverlay();
}
