// Модальные диалоги оверлея: ввод имени (создание/вход по ссылке), вход по коду
// и короткие всплывающие уведомления (тост). DOM-шторки живут в #overlay.

import { bindTap, openSheet, closeOverlay } from './dom';
import { strings } from '../strings';

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

// Колбэки подтверждения диалогов имени/кода (заполняются при открытии диалога).
let nameCb: ((name: string) => void) | null = null;
let joinCb: ((code: string, name: string) => void) | null = null;

/** Диалог ввода имени (создание игры / вход по ссылке). */
export function openNameDialog(
  confirmLabel: string,
  defaultName: string,
  onConfirm: (name: string) => void,
): void {
  nameConfirm.textContent = confirmLabel;
  nameInput.value = defaultName;
  nameCb = onConfirm;
  openSheet(nameDialog);
  setTimeout(() => nameInput.focus(), 50);
}

function submitName(): void {
  const v = nameInput.value.trim();
  if (!v) {
    nameInput.focus();
    return;
  }
  const cb = nameCb;
  closeOverlay();
  cb?.(v);
}

/** Диалог входа по коду (код + имя). Оверлей не закрывается сам — это делает вызывающий. */
export function openJoinDialog(
  defaultName: string,
  defaultCode: string,
  onConfirm: (code: string, name: string) => void,
): void {
  joinCodeInput.value = defaultCode;
  joinNameInput.value = defaultName;
  joinError.hidden = true;
  setJoinBusy(false);
  joinCb = onConfirm;
  openSheet(joinDialog);
  setTimeout(() => (defaultCode ? joinNameInput : joinCodeInput).focus(), 50);
}

/** Пока идёт запрос входа: заблокировать кнопку и показать «Подключаемся…»,
 *  чтобы повторные тапы не плодили параллельные join'ы. */
export function setJoinBusy(busy: boolean): void {
  joinConfirm.disabled = busy;
  joinConfirm.textContent = busy ? strings.online.joining : strings.online.joinSubmit;
}

function submitJoin(): void {
  const code = joinCodeInput.value.trim().toUpperCase();
  const name = joinNameInput.value.trim();
  if (!code || !name) return;
  joinError.hidden = true;
  joinCb?.(code, name);
}

/** Показать ошибку в диалоге входа (не закрывая его). */
export function showJoinError(msg: string): void {
  joinError.textContent = msg;
  joinError.hidden = false;
}

/** Показать/скрыть баннер «нет связи» (обрыв realtime-канала). */
export function setConnBanner(lost: boolean): void {
  connBanner.hidden = !lost;
}

let toastTimer: number | undefined;

/** Короткое всплывающее уведомление (ссылка/код скопированы и т.п.). */
export function showToast(msg: string): void {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 1800);
}

/** Навесить подтверждение диалогов (кнопки + Enter в полях ввода). */
export function bindDialogs(): void {
  bindTap(nameConfirm, submitName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitName();
  });
  bindTap(joinConfirm, submitJoin);
  joinNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitJoin();
  });
}
