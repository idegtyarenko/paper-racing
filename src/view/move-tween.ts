// The car catching up with its own move: spot the move that just happened and
// slide the car into it.
//
// Split out of main.ts (which had grown into a god-module). Same layer and same
// nature as view/replay-player.ts — a clock, an eased position and a
// MotionFrame — and like it, it doesn't own the frame slot: the app hands it a
// showFrame and reads the result back in its redraw.

import { Vec, lerp } from '../geometry';
import { GameState } from '../model/game';
import { startAnim, easeOutCubic, prefersReducedMotion } from './anim';
import { isReplaying } from './replay-player';
import { MotionFrame } from './render';

/**
 * How long a car takes to slide into the point it just moved to (ms). Short
 * enough that it's over before anyone can act on the next turn — the move
 * itself is applied instantly, this is only the picture catching up.
 */
const TWEEN_MS = 220;

export interface MoveTweenDeps {
  /** The race in progress (null outside a race). */
  game: () => GameState | null;
  /** Put this frame on the board — or clear it (the app owns the frame slot). */
  showFrame: (m: MotionFrame | null) => void;
}

let deps: MoveTweenDeps;

export function initMoveTween(d: MoveTweenDeps): void {
  deps = d;
}

/** Trail length per seat as of the last screen update — how a new move is spotted. */
let seenSegs: number[] = [];

/**
 * Spot the move that just happened and slide the car into it. Called from
 * updateUI, which is the one place every path funnels through — our own move,
 * a bot's, and an opponent's arriving over the network — so no mover is missed
 * and none is animated twice.
 *
 * Deliberately cosmetic: the state has already moved on, and nothing waits for
 * the animation. Queueing the next turn behind it would mean holding back bot
 * moves and incoming online state for 220ms, which is a race condition bought
 * at the price of a smaller one.
 */
export function noteMoves(): void {
  const g = deps.game();
  if (!g) {
    seenSegs = [];
    return;
  }
  const now = g.players.map((p) => p.trail.length);
  const seat = now.findIndex((n, i) => n > (seenSegs[i] ?? n));
  seenSegs = now;
  if (seat < 0 || isReplaying()) return;
  const seg = g.players[seat].trail[now[seat] - 1];
  // The teleport out of the gravel isn't a drive — it has no in-between.
  if (seg.jump || prefersReducedMotion()) return;

  const nil = g.players.map(() => null);
  const segsShown = g.players.map(() => null as number | null);
  const crashesShown = g.players.map(() => null as number | null);
  segsShown[seat] = now[seat] - 1;
  // A crash mark belongs to the moment of impact, not to the move that ends in
  // it: hold the newest one back until the car gets there.
  const crashes = g.players[seat].crashes;
  const crashed =
    crashes.length > 0 &&
    crashes[crashes.length - 1].x === seg.to.x &&
    crashes[crashes.length - 1].y === seg.to.y;
  if (crashed) crashesShown[seat] = crashes.length - 1;

  startAnim(
    (ms) => {
      const u = Math.min(1, ms / TWEEN_MS);
      const at = lerp(seg.from, seg.to, easeOutCubic(u));
      const pos = [...nil] as (Vec | null)[];
      const partialTo = [...nil] as (Vec | null)[];
      pos[seat] = at;
      partialTo[seat] = at;
      deps.showFrame({ pos, segsShown, partialTo, crashesShown, trailDim: 0 });
      return u < 1;
    },
    () => {
      deps.showFrame(null);
    },
  );
}
