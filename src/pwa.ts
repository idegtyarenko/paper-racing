// Registers the service worker in `prompt` mode (see vite.config.ts). The SW
// does NOT call self.skipWaiting() on its own: on iOS standalone that still
// doesn't displace the active worker while the app is open — the new version
// just sits in `waiting`, `controllerchange` never fires, and there's no
// auto-reload (confirmed via an on-device log). So instead we apply the
// update from the CLIENT side: once a new version is installed and waiting
// (`onNeedRefresh`), at a SAFE moment (not mid-race) we send it SKIP_WAITING
// via `updateSW()` — the worker activates, `controlling` fires, and we get
// one reload onto the fresh build.
//
// We check for a new version every time the app returns to the foreground
// (visibilitychange) — deliberately not on a periodic timer, to avoid
// triggering a reload at an inconvenient moment. The same handler also tries
// to apply any previously deferred update (`applyIfIdle`).
//
// SW lifecycle diagnostics (for debugging iOS auto-update) are enabled via
// the `?swdebug` flag — see `sw-debug.ts`.

import { registerSW } from 'virtual:pwa-register';
import { initSwDebug } from './sw-debug';

/**
 * @param isSafeToReload — whether it's safe to reload the page right now
 *   (false while a race is active: reloading mid-move isn't acceptable). The
 *   update accumulates and gets applied on the next safe return to the
 *   foreground.
 */
export function initPwa(isSafeToReload: () => boolean): void {
  const dbg = initSwDebug();
  // A new version is installed and waiting to activate — apply it as soon as
  // it's safe. We don't clear this after applyIfIdle: if iOS still doesn't
  // pick it up on the first try, the next visibilitychange will retry (and
  // log the attempt).
  let pendingRefresh = false;

  // updateSW() (prompt mode) sends SKIP_WAITING to the waiting worker; once
  // `controlling` fires, workbox itself reloads the page onto the new version.
  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(swUrl, registration) {
      dbg.log(`onRegisteredSW sw=${swUrl} reg=${registration ? 'yes' : 'no'}`);
      if (registration) dbg.attachRegistration(registration);
      // On returning to the foreground, check for a new version and apply
      // any deferred update (this replaces the deliberately absent periodic
      // timer).
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        dbg.log('visible → registration.update()');
        const p = registration?.update();
        if (dbg.enabled && p) {
          p.then(
            () =>
              dbg.log(
                `update() ok — waiting=${registration?.waiting ? 'yes' : 'no'} ` +
                  `installing=${registration?.installing ? 'yes' : 'no'}`,
              ),
            (e: unknown) => dbg.log(`update() ERROR: ${String(e)}`),
          );
        }
        applyIfIdle();
      });
    },
    onRegisterError(err) {
      dbg.log(`onRegisterError: ${String(err)}`);
    },
    // A new version is installed and waiting — remember it and try to apply
    // it right away.
    onNeedRefresh() {
      dbg.log('onNeedRefresh (waiting)');
      pendingRefresh = true;
      applyIfIdle();
    },
  });

  // Apply the waiting update if no race is currently active. Otherwise defer
  // it until the next safe moment (pendingRefresh stays armed).
  function applyIfIdle(): void {
    if (!pendingRefresh) return;
    if (!isSafeToReload()) {
      dbg.log('update deferred (in race)');
      return;
    }
    dbg.log('applying update: SKIP_WAITING + reload');
    void updateSW();
  }
}
