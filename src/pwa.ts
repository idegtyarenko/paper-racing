// Регистрация service worker. В режиме autoUpdate (см. vite.config.ts) новая
// версия применяется автоматически, и страница один раз сама перезагружается на
// неё по controllerchange — вместо ручного переоткрытия приложения несколько раз.
// Периодический update()-таймер намеренно не ставим, чтобы не дёрнуть перезагрузку
// посреди заезда; вместо него проверяем на новую версию при каждом возврате
// приложения на передний план (visibilitychange) — чтобы свежая сборка вставала
// уже при ближайшем открытии PWA, а не только после принудительного переоткрытия.
//
// Диагностика жизненного цикла SW (для отладки авто-обновления на iOS) включается
// флагом `?swdebug` — см. `sw-debug.ts`. Здесь только ЛОГИРУЕМ; поведение
// обновления не меняем.

import { registerSW } from 'virtual:pwa-register';
import { initSwDebug } from './sw-debug';

export function initPwa(): void {
  const dbg = initSwDebug();
  registerSW({
    immediate: true,
    onRegisteredSW(swUrl, registration) {
      dbg.log(`onRegisteredSW sw=${swUrl} reg=${registration ? 'yes' : 'no'}`);
      if (registration) dbg.attachRegistration(registration);
      // При возврате приложения на передний план — проверить, не вышла ли новая
      // версия (заменяет намеренно отсутствующий периодический таймер). Найденная
      // новая SW в autoUpdate ставится сама → controllerchange → одна перезагрузка.
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
      });
    },
    onRegisterError(err) {
      dbg.log(`onRegisterError: ${String(err)}`);
    },
  });
}
