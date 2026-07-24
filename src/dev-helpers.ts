// Dev-only test helpers (`window.__pr`). Manually stepping through the editor
// wizard (draw a loop → edges → finish → direction → mode → players) for
// every browser-based check burns a ton of steps and tokens. These helpers
// jump straight to the state we need on a ready-made track and return a
// cheap JSON snapshot — reading state takes one call instead of a chain of
// screenshots.
//
// The module is loaded via dynamic import only under `import.meta.env.DEV`
// (see `main.ts`). IT NEVER ENDS UP IN THE PROD BUNDLE: Vite replaces
// `import.meta.env.DEV` with `false`, the import branch is eliminated as dead
// code, and the chunk is never created — verified via `npm run build` + grep
// over dist. Not visible to end users.

import { AppState } from './app-state';
import { setLocale as applyLocale, type LocaleCode } from './i18n';
import { Track, finalizeTrack, clipFinishLine } from './model/track';
import { editorFromTrack } from './model/editor';
import { Candidate, isFinished, WIN_CROSSINGS } from './model/game';
import { Difficulty } from './model/ai';
import { worldToScreen } from './view/camera';
import * as vp from './view/viewport';
import * as input from './view/input';

/** Dependencies from `main.ts` that the helpers call by reference —
 *  orchestration stays private to main.ts, and we only expose exactly what's
 *  needed here. */
export interface DevHelperDeps {
  S: AppState;
  canvas: HTMLCanvasElement;
  startRace: (humans: number, bots: number, difficulty: Difficulty) => void;
  refreshCands: () => void;
  updateUI: () => void;
  redraw: () => void;
  candOwner: () => number;
  cancelAiMove: () => void;
  commitMove: (cand: Candidate) => void;
  myTurn: () => boolean;
}

export function installDevHelpers(deps: DevHelperDeps): void {
  const {
    S,
    canvas,
    startRace,
    refreshCands,
    updateUI,
    redraw,
    candOwner,
    cancelAiMove,
    commitMove,
    myTurn,
  } = deps;

  // A ready-made rectangular "donut" track: the road is the frame between an
  // outer and an inner rectangle, the finish line crosses the BOTTOM
  // straight, and the race runs in +x. The finish is built the same way the
  // editor does it — a short stroke across the road, clipped to the edges
  // via `clipFinishLine` (its ends extend 0.25 past the edges). That keeps
  // the fixture actually drawable by the wizard: the line spans the full
  // width of the road from edge to edge (y=0 outer → y=8 inner), instead of
  // stopping partway as it used to on the LEFT straight (x=6, where the road
  // runs to y=24 but the line only reached y=8).
  const devTrack = (): Track => {
    const outer = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 24 },
      { x: 0, y: 24 },
    ];
    const inner = [
      { x: 8, y: 8 },
      { x: 32, y: 8 },
      { x: 32, y: 16 },
      { x: 8, y: 16 },
    ];
    const fin = clipFinishLine({ x: 20, y: 3 }, { x: 20, y: 5 }, outer, inner);
    if ('error' in fin) throw new Error(`dev finish invalid: ${fin.error}`);
    const res = finalizeTrack(outer, inner, fin.finish, { x: 1, y: 0 });
    if ('error' in res) throw new Error(`dev track invalid: ${res.error}`);
    return res.track;
  };
  // A cheap snapshot of key state for assertions, no screenshots needed.
  const snap = () => ({
    phase: S.phase,
    // Editor wizard introspection (for verifying the drawing flow without screenshots).
    editor: {
      step: S.editor.step,
      hasFinish: S.editor.finish !== null,
      forward: S.editor.forward,
    },
    gamePhase: S.game?.phase ?? null,
    current: S.game?.current ?? null,
    players:
      S.game?.players.map((p) => ({
        name: p.name,
        bot: p.bot ?? null,
        place: p.place,
        pos: p.pos,
        vel: p.vel,
        crossings: p.crossings,
        finished: isFinished(p),
      })) ?? null,
    lastLocalRace: S.lastLocalRace,
    // Pre-selection: the seat that owns the candidate fan, candidate count,
    // and the current pending pick.
    candSeat: candOwner(),
    candsCount: S.cands?.length ?? null,
    pending: S.pending?.target ?? null,
    hover: input.getHover()?.target ?? null,
  });
  (window as unknown as Record<string, unknown>).__pr = {
    /** Test language switcher: writes the choice to localStorage and reloads.
     *  For checking locales without going through the UI (same effect as
     *  `?lang=en|ru|be` in the URL). */
    setLocale(code: LocaleCode) {
      applyLocale(code);
    },
    /** Editor direction arrows in screen (css px) coords — so a browser test can
     *  tap the exact arrow to flip the pre-selected direction. */
    editorArrowsScreen() {
      const cam = vp.camera();
      const r = canvas.getBoundingClientRect();
      return (S.editor.arrows ?? []).map((a) => {
        const from = worldToScreen(cam, a.from);
        const tip = worldToScreen(cam, a.tip);
        const midW = { x: (a.from.x + a.tip.x) / 2, y: (a.from.y + a.tip.y) / 2 };
        const mid = worldToScreen(cam, midW);
        return {
          forward: a.forward,
          mid: { x: r.left + mid.x, y: r.top + mid.y },
          from: { x: r.left + from.x, y: r.top + from.y },
          tip: { x: r.left + tip.x, y: r.top + tip.y },
        };
      });
    },
    /** Ready-made track plus an immediate local race: `humans` human players,
     *  `bots` bot players. */
    race(humans = 1, bots = 1, difficulty: Difficulty = 'medium') {
      S.raceTrack = devTrack();
      startRace(humans, bots, difficulty);
      return snap();
    },
    /** A live race pushed right up to the finish: every player (human and
     *  bot) gets crossings = WIN−laps, positions are left untouched (cars
     *  stay on the starting grid behind the line). With laps=1, the very
     *  first finish crossing wins — handy for manually playing out the
     *  endgame (place assignment, order freeze, transition to phase='over',
     *  the win screen) without grinding through laps. */
    nearFinish(humans = 1, bots = 1, laps = 1, difficulty: Difficulty = 'medium') {
      S.raceTrack = devTrack();
      startRace(humans, bots, difficulty);
      for (const p of S.game!.players) p.crossings = WIN_CROSSINGS - laps;
      refreshCands();
      updateUI();
      redraw();
      return snap();
    },
    /** A race where the human (seat 0) is one move from winning: crossings =
     *  WIN−1, positioned on the bottom straight just before the finish line
     *  (x=20) with velocity (2,0) carrying it through (18→20); opponents are
     *  moved to the top straight so they don't interfere or finish
     *  themselves. After tapAccel(0,0) the human wins, but place is still
     *  null (the round is still playing out) — this is the "finish window"
     *  during which the finisher should NOT be offered a move. */
    raceAtWin(bots = 1, difficulty: Difficulty = 'medium') {
      S.raceTrack = devTrack();
      startRace(1, bots, difficulty);
      const h = S.game!.players[0];
      h.crossings = WIN_CROSSINGS - 1;
      h.pos = { x: 18, y: 4 };
      h.vel = { x: 2, y: 0 };
      for (let i = 1; i < S.game!.players.length; i++) {
        S.game!.players[i].pos = { x: 16, y: 20 }; // top straight, out of the finisher's way
      }
      refreshCands();
      updateUI();
      redraw();
      return snap();
    },
    /** Ready-made track → editor at the final `ready` step (skipping the
     *  drawing phase): the same shared canvas surface used in-race, plus the
     *  editor overlay. For visually checking the ribbon/edges in edit mode
     *  without going through the wizard. */
    toEdit() {
      S.editor = editorFromTrack(devTrack());
      S.phase = 'edit';
      cancelAiMove();
      updateUI();
      redraw();
      return snap();
    },
    /** Ready-made track → mode-select screen (skipping the drawing phase). */
    toMode() {
      S.raceTrack = devTrack();
      S.playersReturn = 'edit';
      cancelAiMove();
      S.phase = 'modeSelect';
      updateUI();
      redraw();
      return snap();
    },
    /** Clear the saved local lineup (simulates "after an online race," where
     *  a one-tap rematch isn't available and the "Rematch" button is
     *  hidden). */
    clearLastRace() {
      S.lastLocalRace = null;
      updateUI();
      return snap();
    },
    /** Snapshot of app state for assertions. */
    state: snap,
    /**
     * Taps the candidate with acceleration (ax, ay) for the seat that owns
     * the fan — using the same logic as input.endGesture: on someone else's
     * turn this is a pending pick (setPending), on your own turn it commits.
     * Lets tests exercise pre-selection without synthesizing pointer events
     * on the canvas.
     */
    tapAccel(ax: number, ay: number) {
      const seat = candOwner();
      if (seat < 0 || !S.cands) return snap();
      const p = S.game!.players[seat];
      const tx = p.pos.x + p.vel.x + ax;
      const ty = p.pos.y + p.vel.y + ay;
      const c = S.cands.find((k) => k.target.x === tx && k.target.y === ty);
      if (!c) return snap();
      if (!myTurn() && seat >= 0) {
        S.pending = c; // pending pick (same as setPending in input-deps)
        redraw();
      } else {
        commitMove(c);
      }
      return snap();
    },
    /** Confirm the pending pick on your own turn (equivalent to the "Go!"
     *  button). */
    confirm() {
      if (S.pending && myTurn()) commitMove(S.pending);
      return snap();
    },
    /** Synthetic mouse hover over the candidate with acceleration (ax, ay) —
     *  checks that the hover survives someone else's turn (reaimHover). */
    hoverAccel(ax: number, ay: number) {
      const seat = candOwner();
      if (seat < 0) return snap();
      const p = S.game!.players[seat];
      const target = { x: p.pos.x + p.vel.x + ax, y: p.pos.y + p.vel.y + ay };
      const scr = worldToScreen(vp.camera(), target);
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerType: 'mouse',
          clientX: r.left + scr.x,
          clientY: r.top + scr.y,
          bubbles: true,
        }),
      );
      return snap();
    },
    /** Run refreshCands+redraw — simulates an incoming move from another
     *  player without changing state. */
    refresh() {
      refreshCands();
      redraw();
      return snap();
    },
  };
}
