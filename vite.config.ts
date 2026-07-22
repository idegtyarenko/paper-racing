/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Short SHA of the current commit — used as the build label. Works both locally
// and in CI (checkout gives HEAD); falls back to GITHUB_SHA/'dev' where git isn't available.
const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return (process.env.GITHUB_SHA ?? 'dev').slice(0, 7);
  }
})();

export default defineConfig({
  // Overridable so CI can build the staging copy under /paper-racing/staging/
  // alongside the production copy at the root — see .github/workflows/deploy.yml.
  base: process.env.BASE_PATH ?? '/paper-racing/',
  // Build label for the version indicator in the "Rules" popup.
  define: {
    __COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(Date.now()),
  },
  // Unit tests cover only the pure, deterministic core (model, geometry).
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
  },
  plugins: [
    VitePWA({
      // prompt (not autoUpdate): the SW does NOT call self.skipWaiting() on install —
      // on iOS standalone it still won't replace the active worker while the app is
      // open (the new version gets stuck in waiting, controllerchange never fires).
      // Instead the client itself sends SKIP_WAITING at a convenient moment (see src/pwa.ts).
      registerType: 'prompt',
      // We register the SW ourselves in src/pwa.ts (registerSW from virtual:pwa-register),
      // to avoid a double registration.
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Paper Racing',
        short_name: 'Paper Racing',
        // The manifest is one artifact per build (it doesn't vary at runtime), so it
        // stays in the default language (English). The UI's own language is chosen at startup.
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
        // Don't intercept future same-origin API routes (multiplayer).
        navigateFallbackDenylist: [/^\/api/],
      },
    }),
  ],
});
