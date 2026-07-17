// Регистрация service worker. В режиме autoUpdate (см. vite.config.ts) новая
// версия применяется автоматически, и страница один раз сама перезагружается на
// неё по controllerchange — вместо ручного переоткрытия приложения несколько раз.
// Периодический update()-таймер намеренно не ставим, чтобы не дёрнуть перезагрузку
// посреди заезда; вместо него проверяем на новую версию при каждом возврате
// приложения на передний план (visibilitychange) — чтобы свежая сборка вставала
// уже при ближайшем открытии PWA, а не только после принудительного переоткрытия.

import { registerSW } from 'virtual:pwa-register';

export function initPwa(): void {
  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      // При возврате приложения на передний план — проверить, не вышла ли новая
      // версия (заменяет намеренно отсутствующий периодический таймер). Найденная
      // новая SW в autoUpdate ставится сама → controllerchange → одна перезагрузка.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void registration?.update();
      });
    },
  });
}
