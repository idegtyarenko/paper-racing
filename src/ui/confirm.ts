// Универсальный диалог подтверждения действия (например, сдачи). Владеет своим
// DOM: строит шторку .sheet и монтирует её в #overlay при первом вызове —
// разметки в index.html для неё нет (не растим index.html, см. роадмап).

import { bindTap, openSheet, closeOverlay } from './dom';
import { strings } from '../i18n';

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

/** Открыть диалог: заголовок, подпись подтверждающей кнопки и колбэк на «да».
 *  По умолчанию кнопка «да» опасная (красная) — для деструктивных действий вроде
 *  сдачи; для позитивных (например «Вернуться в игру») передать danger:false. */
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
