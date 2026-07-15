// Регистрация service worker. В режиме autoUpdate (см. vite.config.ts) новая
// версия применяется автоматически, и страница один раз сама перезагружается на
// неё по controllerchange — вместо ручного переоткрытия приложения несколько раз.
// Периодический update()-таймер намеренно не ставим, чтобы не дёрнуть перезагрузку
// посреди заезда; проверка на новую версию происходит при каждом открытии PWA.

import { registerSW } from 'virtual:pwa-register';

export function initPwa(): void {
  registerSW({ immediate: true });
}
