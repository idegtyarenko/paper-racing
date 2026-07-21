/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Короткий SHA текущего коммита — метка сборки. Работает и локально, и в CI
// (checkout даёт HEAD); фолбэк на GITHUB_SHA/'dev' для окружений без git.
const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return (process.env.GITHUB_SHA ?? 'dev').slice(0, 7);
  }
})();

export default defineConfig({
  base: '/paper-racing/',
  // Метка сборки для индикатора версии в попапе «Правила».
  define: {
    __COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(Date.now()),
  },
  // Юнит-тесты покрывают только чистое детерминированное ядро (model, geometry).
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
  },
  plugins: [
    VitePWA({
      // prompt (а не autoUpdate): SW НЕ делает self.skipWaiting() на install —
      // на iOS-standalone он всё равно не вытесняет активный воркер при открытом
      // приложении (новая версия зависает в waiting, controllerchange не стреляет).
      // Вместо этого сам клиент шлёт SKIP_WAITING в удобный момент (см. src/pwa.ts).
      registerType: 'prompt',
      // Регистрируем SW сами в src/pwa.ts (registerSW из virtual:pwa-register),
      // чтобы не было двойной регистрации.
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Paper Racing',
        short_name: 'Paper Racing',
        // Манифест — один артефакт на сборку (рантаймом не варьируется), поэтому на
        // языке по умолчанию (английский). Язык самого UI выбирается на старте.
        description: 'A pen-and-paper racing game: draw a track and outrace your rivals.',
        lang: 'en',
        dir: 'ltr',
        display: 'standalone',
        orientation: 'any',
        start_url: '.',
        scope: '.',
        background_color: '#fbfaf4',
        theme_color: '#0a8a4f',
        // prettier-ignore
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Не перехватывать будущие same-origin API-роуты (мультиплеер).
        navigateFallbackDenylist: [/^\/api/],
      },
    }),
  ],
});
