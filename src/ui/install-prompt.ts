// Всплывашка «установить ярлык на рабочий стол/домой», показывается на мобильных.
//
// Два сценария:
//   • Android/Chromium — ловим событие `beforeinstallprompt`, гасим нативную
//     мини-плашку и показываем свою кнопку, которая вызывает системный диалог.
//   • iOS Safari — событие не поддерживается, поэтому показываем инструкцию
//     «Поделиться → На экран „Домой“» с иконкой кнопки «Поделиться».
//
// Не показываем, если игра уже открыта как установленное приложение
// (display-mode: standalone) или пользователь недавно закрыл всплывашку.

import { strings } from '../i18n';

const DISMISS_KEY = 'pr-install-dismissed';
const DISMISS_MS = 14 * 864e5; // молчим 14 дней после «Закрыть»

// «Мягкое» снятие: пользователь тапнул по доске (начал играть), не закрыв ×.
// Раньше это вообще не запоминалось, и плашка выпрыгивала каждый запуск. Теперь
// молчим по нарастающей — с каждым таком окно тишины растёт (1 → 3 → 7 → 14 дней),
// чтобы не навязываться, но всё же напомнить установить, если игрок не закрыл её сам.
const SOFT_KEY = 'pr-install-soft';
const SOFT_STEPS_MS = [1, 3, 7, 14].map((d) => d * 864e5);

/** Нестандартное событие Chromium: даёт вызвать нативный диалог установки. */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

/** Игра уже запущена как установленное приложение (без браузерной панели). */
function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS помечает добавленную на «Домой» веб-иконку так:
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** Основной указатель — палец (телефон/планшет). Всплывашка только для них. */
function isMobile(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}

function isIos(): boolean {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS 13+ выдаёт себя за Mac, но у него мультитач.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/** Именно Safari на iOS: только в нём работает «Поделиться → На экран „Домой“». */
function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  return isIos() && /safari/i.test(ua) && !/crios|fxios|edgios|opios/i.test(ua);
}

function recentlyDismissed(): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(DISMISS_KEY) || 0) < DISMISS_MS;
  } catch {
    return false;
  }
}

function markDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {}
}

/** Сколько ещё молчать после «мягкого» снятия (по нарастающей). */
function softlySilenced(): boolean {
  try {
    const raw = localStorage.getItem(SOFT_KEY);
    if (!raw) return false;
    const { at, n } = JSON.parse(raw) as { at: number; n: number };
    if (typeof at !== 'number' || typeof n !== 'number') return false;
    const window = SOFT_STEPS_MS[Math.min(n, SOFT_STEPS_MS.length - 1)];
    return Date.now() - at < window;
  } catch {
    return false;
  }
}

/** Запомнить «мягкое» снятие и удлинить следующее окно тишины на шаг. */
function markSoftDismissed(): void {
  try {
    let n = 0;
    const raw = localStorage.getItem(SOFT_KEY);
    if (raw) {
      const prev = JSON.parse(raw) as { n?: number };
      if (typeof prev.n === 'number') n = prev.n + 1;
    }
    localStorage.setItem(SOFT_KEY, JSON.stringify({ at: Date.now(), n }));
  } catch {}
}

/** Иконка кнопки «Поделиться» iOS (квадрат со стрелкой вверх) — для инструкции. */
function shareIcon(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'install-prompt__share';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round">' +
    '<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/>' +
    '<path d="M7 12H6a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2h-1"/>' +
    '</svg>';
  return span;
}

/** Собрать DOM всплывашки. Для iOS кнопки установки нет — только инструкция. */
function build(
  kind: 'android' | 'ios',
  onInstall: () => void,
  onClose: () => void,
): HTMLElement {
  const box = document.createElement('div');
  box.className = 'install-prompt';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', strings.install.title);

  const icon = document.createElement('img');
  icon.className = 'install-prompt__icon';
  icon.src = `${import.meta.env.BASE_URL}pwa-192x192.png`;
  icon.alt = '';

  const text = document.createElement('div');
  text.className = 'install-prompt__text';
  const title = document.createElement('b');
  title.className = 'install-prompt__title';
  title.textContent = strings.install.title;
  const body = document.createElement('span');
  body.className = 'install-prompt__body';
  if (kind === 'ios') {
    body.append(strings.install.iosBefore, shareIcon(), strings.install.iosAfter);
  } else {
    body.textContent = strings.install.body;
  }
  text.append(title, body);

  const close = document.createElement('button');
  close.className = 'install-prompt__close';
  close.setAttribute('aria-label', strings.install.close);
  close.textContent = '×';
  close.addEventListener('click', onClose);

  box.append(icon, text);
  if (kind === 'android') {
    const install = document.createElement('button');
    install.className = 'install-prompt__install';
    install.textContent = strings.install.action;
    install.addEventListener('click', onInstall);
    box.append(install);
  }
  box.append(close);
  return box;
}

/**
 * Подключить всплывашку установки. Вызывать один раз при старте.
 * Ничего не делает на десктопе и в уже установленном приложении.
 */
export function initInstallPrompt(): void {
  if (!isMobile() || isStandalone() || recentlyDismissed() || softlySilenced()) return;

  let deferred: BeforeInstallPromptEvent | null = null;
  let el: HTMLElement | null = null;

  function remove(): void {
    el?.remove();
    el = null;
  }

  function show(kind: 'android' | 'ios'): void {
    if (el || isStandalone()) return;
    el = build(
      kind,
      async () => {
        // Android: показать системный диалог установки.
        if (!deferred) return;
        remove();
        deferred.prompt();
        await deferred.userChoice;
        deferred = null;
        markDismissed(); // выбор сделан — больше не навязываемся
      },
      () => {
        remove();
        markDismissed();
      },
    );
    document.body.append(el);
    requestAnimationFrame(() => el?.classList.add('install-prompt--in'));

    // Пользователь начал играть — убираем всплывашку с дороги и «мягко» молчим по
    // нарастающей, чтобы она не выпрыгивала каждый запуск, но напомнила позже.
    document.getElementById('board')?.addEventListener(
      'pointerdown',
      () => {
        remove();
        markSoftDismissed();
      },
      { once: true },
    );
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // не показывать нативную мини-плашку — покажем свою
    deferred = e as BeforeInstallPromptEvent;
    show('android');
  });

  // iOS Safari не шлёт beforeinstallprompt — показываем инструкцию с задержкой,
  // чтобы всплывашка не выпрыгивала одновременно с загрузкой поля.
  if (isIosSafari()) {
    setTimeout(() => show('ios'), 1400);
  }

  // Установили из нашей кнопки или из меню браузера — прячем и запоминаем.
  window.addEventListener('appinstalled', () => {
    remove();
    markDismissed();
  });
}
