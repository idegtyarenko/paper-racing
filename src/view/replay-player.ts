// The replay's clock: turns the schedule from replay-timeline.ts into frames on
// the board, and owns the camera detour the replay makes and gives back.
//
// Split out of main.ts (which had grown into a god-module): the composition
// root wires the app together, it shouldn't own a playback mode.
//
// Nothing about the game state is touched — this is the same board, drawn from
// a schedule. The way out (a close button) is DOM chrome and lives in
// ui/race-replay.ts: this module is in view/ and doesn't import ui/, so it gets
// the chrome as callbacks.

import { GameState } from '../model/game';
import { startAnim, stopAnim } from './anim';
import { buildTimeline, sampleTimeline } from './replay-timeline';
import { MotionFrame } from './render';
import * as vp from './viewport';

/**
 * How long one round of the replay takes (ms) — one move by every car. Slow
 * enough to follow six cars at once, fast enough that a long race doesn't turn
 * into a sitting; a race long enough to exceed REPLAY_MAX_MS is played at a
 * proportionally shorter beat rather than being cut off.
 */
const REPLAY_BEAT_MS = 320;
const REPLAY_MAX_MS = 30000;
/** A beat on the starting grid before anyone moves, so the eye can find its car. */
const REPLAY_LEAD_MS = 500;

export interface ReplayDeps {
  /** The race to replay (null outside a race). */
  game: () => GameState | null;
  /** Put this frame on the board — or clear it (the app owns the frame slot). */
  showFrame: (m: MotionFrame | null) => void;
  /** The way out, up while the replay is playing. */
  showChrome: (onExit: () => void) => void;
  hideChrome: () => void;
  /** Bring the screen back to the state behind the replay (panels, buttons). */
  refreshUI: () => void;
}

let deps: ReplayDeps;

export function initReplay(d: ReplayDeps): void {
  deps = d;
}

/** The race being replayed, or null — also the "is the replay up" flag. */
let replay: { view: vp.ViewState } | null = null;

export function isReplaying(): boolean {
  return replay !== null;
}

/**
 * Watch the finished race drive itself: the cars run their real trajectories at
 * their real relative speeds, the trails they've already drawn dimmed behind
 * them, and the whole track held in frame (nothing to aim at, so nothing to
 * follow).
 */
export function enterReplay(): void {
  const g = deps.game();
  if (!g || replay) return;
  const tl = buildTimeline(g);
  if (tl.rounds === 0) return; // nobody drove: nothing to watch

  replay = { view: vp.viewState() };
  // Chrome up before the fit — the framing works around whatever panels are on
  // screen, so it has to see the replay's own chrome, not the one it replaced.
  deps.showChrome(exitReplay);
  vp.fitToContent();
  const beat = Math.min(REPLAY_BEAT_MS, REPLAY_MAX_MS / tl.rounds);
  startAnim(
    (ms) => {
      const t = Math.min(tl.rounds, Math.max(0, (ms - REPLAY_LEAD_MS) / beat));
      deps.showFrame(sampleTimeline(tl, g, t));
      return t < tl.rounds;
    },
    () => {
      // Over the line: the trails come back to full strength and the board is
      // the one behind the result screen again. It stays up until it's closed —
      // dropping the player back mid-glance would be its own kind of rude.
      deps.showFrame(null);
    },
  );
}

function exitReplay(): void {
  if (!replay) return;
  const { view } = replay;
  replay = null;
  stopAnim();
  deps.hideChrome();
  vp.restoreView(view);
  deps.refreshUI();
  deps.showFrame(null);
}
