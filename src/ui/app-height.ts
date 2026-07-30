// Works around an iOS standalone (home-screen PWA) layout bug, measured on
// device: at launch the web view is placed at y=0 (the page runs under the
// status bar — `apple-mobile-web-app-status-bar-style=black-translucent` +
// `viewport-fit=cover`), but its HEIGHT is computed as if the page started
// BELOW the status bar. On an iPhone X that's `innerHeight=768` on an 812pt
// screen — 44px of screen the page simply never covers, showing the shell's
// window (manifest `background_color`) as a strip along the bottom edge. iOS
// only recomputes it on a real orientation change, so the strip survives the
// whole session; and no CSS length helps, because `100dvh`, `100%` and even a
// `position: fixed; inset: 0` box all resolve against that same short layout
// viewport.
//
// So we measure it ourselves and publish the true height as `--pr-app-h`
// (consumed by `body` in base.css). When the viewport is correct — every other
// browser, and iOS itself after a rotation — the variable is removed and the
// `100dvh` default applies again.

/** Largest shortfall we're willing to treat as the bug, in CSS px. The status
 *  bar is ~44–59pt; anything bigger is a legitimately smaller viewport (an
 *  iPad in Split View or Stage Manager), which we must NOT stretch. */
const MAX_SHORTFALL = 64;

/** Whether launched from a home-screen shortcut (iOS standalone / display-mode). */
function isStandalone(): boolean {
  const iosStandalone =
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

/** The physical screen height in the CURRENT orientation. `screen.width/height`
 *  don't rotate on iOS (they stay portrait-shaped), so we pick by orientation. */
function screenHeight(): number {
  const a = window.screen.width;
  const b = window.screen.height;
  const portrait = window.innerWidth <= window.innerHeight;
  return portrait ? Math.max(a, b) : Math.min(a, b);
}

function sync(): void {
  const root = document.documentElement;
  if (!isStandalone()) {
    root.style.removeProperty('--pr-app-h');
    return;
  }
  const target = screenHeight();
  const shortfall = target - window.innerHeight;
  if (shortfall > 0 && shortfall <= MAX_SHORTFALL) {
    root.style.setProperty('--pr-app-h', `${target}px`);
  } else {
    root.style.removeProperty('--pr-app-h');
  }
}

/**
 * Start keeping `--pr-app-h` in sync with the real screen height. Call once, as
 * early as possible — the first sync happens immediately, then on every
 * resize/orientation change and on each return to the foreground (iOS can fix
 * the viewport on its own, and then the override has to go away).
 */
export function initAppHeight(): void {
  sync();
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync();
  });
}
