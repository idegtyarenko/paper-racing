// Registers the service worker in `prompt` mode (see vite.config.ts). The SW
// does NOT call self.skipWaiting() on its own: on iOS standalone that still
// doesn't displace the active worker while the app is open — the new version
// just sits in `waiting`, `controllerchange` never fires, and there's no
// auto-reload (confirmed via an on-device log). So instead we apply the
// update from the CLIENT side: once a new version is installed and waiting
// (`onNeedRefresh`), at a SAFE moment (not mid-race) we send it SKIP_WAITING
// via `updateSW()` — the worker activates, `controlling` fires, and we get
// one reload onto the fresh build. (The staging preview applies the update
// immediately instead of waiting for a safe moment — see `__PWA_EAGER_UPDATE__`.)
//
// We check for a new version at startup, on `pageshow` (Safari fires it on a
// bfcache restore, where there's no visibilitychange), on `focus` (in a
// desktop tab, an app/window switch fires nothing else — the tab stays
// `visible`) and every time the app returns to the foreground
// (visibilitychange) — in production deliberately
// not on a periodic timer, to avoid triggering a reload at an inconvenient
// moment. Staging DOES poll (see `__PWA_EAGER_UPDATE__`): it's a preview env,
// there's no cost to a reload, and it's how we see a deploy land. Every check
// also tries to apply any previously deferred update (`applyIfIdle`).
//
// The registration is re-registered with `updateViaCache: 'none'` (registerSW
// from virtual:pwa-register hardcodes `{scope, type}` and gives no way to pass
// it). GitHub Pages serves everything — sw.js included — with
// `cache-control: max-age=600` and can't be configured; Safari has honoured
// that on the SW script itself despite the `updateViaCache: 'imports'`
// default, so for ~10 minutes after a deploy every update() was a no-op
// against the HTTP cache. 'none' forces the script fetch to skip the cache.
//
// SW lifecycle diagnostics (for debugging iOS auto-update) are enabled via
// the `?swdebug` flag — see `sw-debug.ts`.

import { registerSW } from 'virtual:pwa-register';
import { initSwDebug } from './sw-debug';

/** Don't re-fetch sw.js more often than this — resume signals overlap. */
const MIN_CHECK_INTERVAL_MS = 10_000;
/** Staging poll interval (production doesn't poll at all). */
const POLL_INTERVAL_MS = 60_000;

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
  // When we last asked for a new version — see `checkForUpdate`.
  let lastCheck = 0;

  // updateSW() (prompt mode) sends SKIP_WAITING to the waiting worker; once
  // `controlling` fires, workbox itself reloads the page onto the new version.
  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(swUrl, registration) {
      dbg.log(`onRegisteredSW sw=${swUrl} reg=${registration ? 'yes' : 'no'}`);
      if (!registration) return;
      dbg.attachRegistration(registration);
      wireUpdateChecks(registration, ensureNoCachedSwScript(swUrl, registration));
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

  /** Re-register the same script with `updateViaCache: 'none'` so update checks
   *  fetch sw.js past the HTTP cache. Per the register algorithm the mode is
   *  written onto the existing registration, so this doesn't create a second
   *  one and doesn't unregister anything.
   *
   *  It runs on every load, not just the first: workbox registers first with
   *  the default (`imports`), and that write lands on the same registration —
   *  so the mode is back to `imports` by the time we get here. Only the checks
   *  we make afterwards bypass the cache, which is why the startup check waits
   *  for this. */
  function ensureNoCachedSwScript(
    swUrl: string,
    registration: ServiceWorkerRegistration,
  ): Promise<void> {
    if (registration.updateViaCache === 'none') return Promise.resolve();
    dbg.log(`updateViaCache=${registration.updateViaCache} → re-register as 'none'`);
    return navigator.serviceWorker
      .register(swUrl, { scope: registration.scope, updateViaCache: 'none' })
      .then(
        (reg) => dbg.log(`re-register ok — updateViaCache=${reg.updateViaCache}`),
        (e: unknown) => dbg.log(`re-register ERROR: ${String(e)}`),
      );
  }

  /** Ask for a new version and apply anything already waiting. Rate-limited:
   *  the resume signals overlap (a Safari tab switch fires pageshow AND
   *  visibilitychange), and there's no point re-fetching sw.js twice in a row. */
  function checkForUpdate(reason: string, registration: ServiceWorkerRegistration): void {
    const now = Date.now();
    if (now - lastCheck < MIN_CHECK_INTERVAL_MS) {
      dbg.log(`${reason} → update() skipped (checked ${now - lastCheck}ms ago)`);
      applyIfIdle();
      return;
    }
    lastCheck = now;
    dbg.log(`${reason} → registration.update()`);
    const p = registration.update();
    if (dbg.enabled) {
      p.then(
        () =>
          dbg.log(
            `update() ok — waiting=${registration.waiting ? 'yes' : 'no'} ` +
              `installing=${registration.installing ? 'yes' : 'no'}`,
          ),
        (e: unknown) => dbg.log(`update() ERROR: ${String(e)}`),
      );
    } else {
      p.catch(() => {
        // offline / Pages hiccup — the next resume signal retries
      });
    }
    applyIfIdle();
  }

  function wireUpdateChecks(
    registration: ServiceWorkerRegistration,
    ready: Promise<void>,
  ): void {
    // At startup: a tab that's opened and then just left alone never fires a
    // resume signal, so without this it would never check at all. Deferred
    // until the cache mode has been written, or this very first check — the
    // one right after a deploy — is the one that still hits the HTTP cache.
    void ready.then(() => checkForUpdate('startup', registration));
    // Returning to the foreground. `pageshow` is what Safari fires on a
    // bfcache restore (visibilitychange doesn't fire there).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      checkForUpdate('visible', registration);
    });
    window.addEventListener('pageshow', (e) => {
      checkForUpdate(`pageshow(persisted=${e.persisted})`, registration);
    });
    // In a normal desktop tab, switching apps or windows leaves the tab
    // `visible` (macOS Safari doesn't fire visibilitychange for it) — `focus`
    // is the only signal that the page was come back to. Same reload guard as
    // the others, so this isn't the periodic timer through the back door.
    window.addEventListener('focus', () => {
      checkForUpdate('focus', registration);
    });
    // Staging only: poll, so a deploy lands in an already-open tab without
    // having to touch it. Production stays event-driven on purpose.
    if (__PWA_EAGER_UPDATE__) {
      window.setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        checkForUpdate('poll', registration);
      }, POLL_INTERVAL_MS);
    }
  }

  // Apply the waiting update. Production defers while a race is active (a reload
  // mid-move isn't acceptable) and retries on the next safe foreground return.
  // Staging is a preview env — it applies immediately so it's always fresh, even
  // if that means a reload during a race (updates only land right after a deploy).
  function applyIfIdle(): void {
    if (!pendingRefresh) return;
    if (!__PWA_EAGER_UPDATE__ && !isSafeToReload()) {
      dbg.log('update deferred (in race)');
      return;
    }
    dbg.log('applying update: SKIP_WAITING + reload');
    void updateSW();
  }
}
