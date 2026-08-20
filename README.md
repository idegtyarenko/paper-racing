# Paper Racing 🏁

**Racing on graph paper** — also known as _Racetrack_, the classic pen-and-paper game where race cars move across a grid.

**[Play!](https://idegtyarenko.github.io/paper-racing/)**

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/idegtyarenko/paper-racing)

> 🧑‍🍼 This is a vibe-coding project I'm building with my younger son: we invent rules, draw tracks, play, and fix whatever we didn't like right away.

## Features

- ✏️ **Custom tracks** — draw any layout instead of picking from presets.
- 🧠 **Cars that handle differently** — pick a preset (Classic, Sports, GT, F1) or move the sliders yourself: acceleration, braking, grip and downforce. Classic is the pen-and-paper ±1 inertia rule; the rest share one traction limit — brake hard and turn hard at once and you run out of grip, so real racing lines with an apex emerge.
- 🌐 **Online multiplayer** — play together via a [Supabase](https://supabase.com) backend.
- 🤖 **Single-player with bots**.
- 📱 **PWA** — installable on the home screen and works like an app, including offline (local play).
- ⚙️ **Race settings** — laps, off-track penalty (a fixed number of turns or scaled by how fast you flew off), and a time limit per turn for online games.
- 🎬 **Replay** — watch the whole race play back once it is over.
- 🌍 **Three languages** — English, Russian and Belarusian.

## Tech stack

Plain **TypeScript** with no framework, rendered on `<canvas>`, built with **Vite**, offline support via `vite-plugin-pwa`. Online — **Supabase** (realtime + REST). Tests — **Vitest**.

## Getting started

```bash
npm install
npm run dev        # local dev server
```

For online mode, copy `.env.example` → `.env` and fill in your Supabase project keys. Without them the build still works and local play works fine — only the online entry points are hidden.

```bash
npm run build       # typecheck + tests + production build
npm run preview     # preview the production build

npm run test        # tests (vitest, single run)
npm run test:watch  # tests in watch mode
npm run typecheck   # type checking only (tsc --noEmit)

npm run format      # format everything (prettier)
npm run format:check # check formatting without changes
npm run typo        # insert non-breaking spaces in UI strings (src/i18n/{en,ru,be}.ts)
npm run typo:check  # check non-breaking spaces without changes
```

## Deployment

`main` deploys to production (the link above) via GitHub Actions on every push (see `.github/workflows/deploy.yml`).

A `staging` branch deploys alongside it, at `/paper-racing/staging/` — push there to preview work (e.g. a redesign) before merging to `main`. Every deploy rebuilds both branches into a single combined artifact, since GitHub Pages replaces the whole site each time; `main`'s build is cached by content hash so a staging-only push can't trigger a spurious PWA update prompt on production.
