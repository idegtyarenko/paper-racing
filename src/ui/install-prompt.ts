// "Add to home screen" install prompt, shown on mobile.
//
// Two scenarios:
//   • Android/Chromium — we catch the `beforeinstallprompt` event, suppress
//     the native mini-banner, and show our own button that triggers the
//     system install dialog.
//   • iOS Safari — the event isn't supported, so we show instructions
//     ("Share → Add to Home Screen") with the Share button's icon.
//
// We don't show it if the game is already running as an installed app
// (display-mode: standalone), or if the user recently dismissed the prompt.

import { strings } from '../i18n';

const DISMISS_KEY = 'pr-install-dismissed';
const DISMISS_MS = 14 * 864e5; // stay quiet for 14 days after an explicit "Close"

// "Soft" dismissal: the user tapped the board (started playing) without
// closing the × first. This used to go unrecorded entirely, so the banner
// popped up on every launch. Now we back off progressively — each occurrence
// grows the quiet window (1 → 3 → 7 → 14 days) — so we don't nag, but still
// remind the player to install if they didn't dismiss it themselves.
const SOFT_KEY = 'pr-install-soft';
const SOFT_STEPS_MS = [1, 3, 7, 14].map((d) => d * 864e5);

/** Non-standard Chromium event: lets us trigger the native install dialog. */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

/** The game is already running as an installed app (no browser chrome). */
function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS flags a web icon added to the home screen like this:
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** Primary input is touch (phone/tablet). The prompt is only for them. */
function isMobile(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}

function isIos(): boolean {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS 13+ identifies itself as a Mac, but has multitouch.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/** Specifically Safari on iOS: only there does "Share → Add to Home Screen" work. */
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

/** How much longer to stay quiet after a "soft" dismissal (progressive backoff). */
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

/** Record a "soft" dismissal and extend the next quiet window by one step. */
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

/** iOS Share-button icon (square with an up arrow) — for the instructions. */
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

/** Build the prompt's DOM. iOS has no install button — just instructions. */
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
 * Wire up the install prompt. Call once at startup.
 * Does nothing on desktop or in an already-installed app.
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
        // Android: show the system install dialog.
        if (!deferred) return;
        remove();
        deferred.prompt();
        await deferred.userChoice;
        deferred = null;
        markDismissed(); // the choice was made — stop nagging
      },
      () => {
        remove();
        markDismissed();
      },
    );
    document.body.append(el);
    requestAnimationFrame(() => el?.classList.add('install-prompt--in'));

    // The user started playing — move the prompt out of the way and go
    // "softly" quiet with progressive backoff, so it doesn't pop up every
    // launch but still reminds them later.
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
    e.preventDefault(); // don't show the native mini-banner — we'll show our own
    deferred = e as BeforeInstallPromptEvent;
    show('android');
  });

  // iOS Safari doesn't send beforeinstallprompt — show the instructions with a
  // delay so the prompt doesn't pop up at the same time as the board is loading.
  if (isIosSafari()) {
    setTimeout(() => show('ios'), 1400);
  }

  // Installed via our button or the browser's menu — hide and remember it.
  window.addEventListener('appinstalled', () => {
    remove();
    markDismissed();
  });
}
