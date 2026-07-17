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
      registerType: 'autoUpdate',
      // Регистрируем SW сами в src/pwa.ts (registerSW из virtual:pwa-register),
      // чтобы не было двойной регистрации.
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Paper Racing',
        short_name: 'Paper Racing',
        description: 'Гонки по клеточкам: черти трассу и обгоняй соперников.',
        lang: 'ru',
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
