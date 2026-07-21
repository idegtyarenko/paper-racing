// Регистрация service worker в режиме `prompt` (см. vite.config.ts). SW НЕ
// вызывает self.skipWaiting() сам: на iOS-standalone это всё равно не вытесняет
// активный воркер при открытом приложении — новая версия зависает в `waiting`,
// `controllerchange` не стреляет, авто-перезагрузки нет (подтверждено on-device
// логом). Поэтому применяем обновление КЛИЕНТОМ: когда новая версия установлена
// и ждёт (`onNeedRefresh`), в БЕЗОПАСНЫЙ момент (не посреди заезда) шлём ей
// SKIP_WAITING через `updateSW()` — воркер активируется, `controlling` → одна
// перезагрузка на свежую сборку.
//
// Проверку на новую версию делаем при каждом возврате приложения на передний
// план (visibilitychange) — периодический таймер намеренно не ставим, чтобы не
// дёрнуть перезагрузку в неподходящий момент. Там же пытаемся применить ранее
// отложенное обновление (`applyIfIdle`).
//
// Диагностика жизненного цикла SW (для отладки авто-обновления на iOS) включается
// флагом `?swdebug` — см. `sw-debug.ts`.

import { registerSW } from 'virtual:pwa-register';
import { initSwDebug } from './sw-debug';

/**
 * @param isSafeToReload — можно ли сейчас перезагрузить страницу (false, если идёт
 *   активный заезд: перезагрузка посреди хода недопустима). Обновление копится и
 *   применяется при ближайшем безопасном возврате на передний план.
 */
export function initPwa(isSafeToReload: () => boolean): void {
  const dbg = initSwDebug();
  // Новая версия установлена и ждёт активации — применить, как только станет
  // безопасно. Не гасим после applyIfIdle: если iOS всё же не подхватит с первого
  // раза, следующий visibilitychange повторит попытку (и залогирует её).
  let pendingRefresh = false;

  // updateSW() (prompt-режим) шлёт SKIP_WAITING ждущему воркеру; на `controlling`
  // workbox сам перезагружает страницу на новую версию.
  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(swUrl, registration) {
      dbg.log(`onRegisteredSW sw=${swUrl} reg=${registration ? 'yes' : 'no'}`);
      if (registration) dbg.attachRegistration(registration);
      // При возврате на передний план — проверить новую версию и применить
      // отложенное (заменяет намеренно отсутствующий периодический таймер).
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
    // Новая версия установлена и ждёт — запомнить и попробовать применить сразу.
    onNeedRefresh() {
      dbg.log('onNeedRefresh (waiting)');
      pendingRefresh = true;
      applyIfIdle();
    },
  });

  // Применить ждущее обновление, если сейчас не идёт заезд. Иначе — отложить до
  // следующего безопасного момента (pendingRefresh остаётся взведённым).
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
