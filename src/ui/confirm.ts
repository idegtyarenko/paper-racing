// Универсальный диалог подтверждения действия (например, сдачи). Владеет своим
// DOM: строит шторку .sheet и монтирует её в #overlay при первом вызове —
// разметки в index.html для неё нет (не растим index.html, см. роадмап).

import { bindTap, openSheet, closeOverlay } from './dom';
import { strings } from '../strings';

let sheet: HTMLElement | null = null;
let titleEl: HTMLElement;
let yesBtn: HTMLButtonElement;
let onYes: () => void = () => {};

/** Собрать шторку подтверждения и смонтировать её в оверлей (однократно). */
function build(): HTMLElement {
  const overlay = document.getElementById('overlay')!;
  const s = document.createElement('div');
  s.className = 'sheet';
  s.hidden = true;

  titleEl = document.createElement('h2');
  titleEl.className = 'sheet__title';

  yesBtn = document.createElement('button');
  yesBtn.type = 'button';
  yesBtn.className = 'button button--center button--danger';

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

/** Открыть диалог: заголовок, подпись подтверждающей кнопки и колбэк на «да». */
export function openConfirm(
  title: string,
  confirmLabel: string,
  onConfirm: () => void,
): void {
  if (!sheet) sheet = build();
  titleEl.textContent = title;
  yesBtn.textContent = confirmLabel;
  onYes = onConfirm;
  openSheet(sheet);
}
