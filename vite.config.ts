/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Overridable so CI can build the staging copy under /paper-racing/staging/
// alongside the production copy at the root — see .github/workflows/deploy.yml.
const base = process.env.BASE_PATH ?? '/paper-racing/';
// The staging preview lives under /paper-racing/staging/. It updates eagerly and
// doesn't guard its own SW scope the way production does (see below / src/pwa.ts).
const isStaging = base.includes('/staging/');

// Short SHA of the current commit — used as the build label. Works both locally
// and in CI (checkout gives HEAD); falls back to GITHUB_SHA/'dev' where git isn't available.
const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return (process.env.GITHUB_SHA ?? 'dev').slice(0, 7);
  }
})();

// Label time = the last commit's date on this branch, NOT the wall clock at build.
// The "Rules" popup should show when the code last changed, so a rebuild of an
// unchanged commit doesn't look newer. Bonus: a commit-derived time makes the
// bundle deterministic per commit — rebuilding the same commit yields identical
// output instead of spuriously bumping the SW precache manifest.
const commitTime = (() => {
  try {
    return Number(execSync('git show -s --format=%ct HEAD').toString().trim()) * 1000;
  } catch {
    return Date.now();
  }
})();

export default defineConfig({
  base,
  // Build label for the version indicator in the "Rules" popup.
  define: {
    __COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(commitTime),
    // Staging applies a waiting SW update immediately; production waits for a
    // safe (not mid-race) moment. See src/pwa.ts.
    __PWA_EAGER_UPDATE__: JSON.stringify(isStaging),
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
        navigateFallbackDenylist: [
          // Don't intercept future same-origin API routes (multiplayer).
          /^\/api/,
          // Production's SW scope ('/paper-racing/') also covers the staging
          // sub-app at '/paper-racing/staging/'. Without this, a navigation
          // there could be answered from production's precached index.html
          // (the prod shell hijacking staging). Let those fall through to the
          // network so GitHub Pages serves the real staging shell. The staging
          // build must NOT denylist its own root, or it loses offline fallback.
          ...(isStaging ? [] : [/^\/paper-racing\/staging\//]),
        ],
      },
    }),
  ],
});
