// The app's one animation ticker. Everything else in the app is event-driven —
// a state change calls redraw() and the frame is done — so there is exactly one
// rAF loop here, borrowed in turn by whoever is animating (the post-move car
// tween, the race replay). Two animations never overlap: the tween happens in a
// live race, the replay on the result screen.
//
// Time is measured by summing frame deltas rather than from a start timestamp,
// with each delta capped: a backgrounded tab stops firing rAF, and without the
// cap the first frame after coming back would jump the animation forward by the
// whole time away. Capping turns that into a pause.

/** Longest frame delta we believe (ms). Beyond it the tab was away. */
const MAX_FRAME_MS = 100;

let rafId = 0;
let elapsed = 0;
let last = 0;
let onDone: (() => void) | undefined;

/**
 * Run `tick(elapsedMs)` every frame until it returns false, then call `onEnd`.
 * Replaces any animation already running (without ending it — the new one owns
 * the frame from here on).
 */
export function startAnim(
  tick: (elapsedMs: number) => boolean,
  onEnd?: () => void,
): void {
  stopAnim();
  elapsed = 0;
  last = performance.now();
  onDone = onEnd;
  const step = (now: number): void => {
    elapsed += Math.min(MAX_FRAME_MS, now - last);
    last = now;
    if (tick(elapsed)) {
      rafId = requestAnimationFrame(step);
      return;
    }
    rafId = 0;
    const end = onDone;
    onDone = undefined;
    end?.();
  };
  rafId = requestAnimationFrame(step);
}

/** Stop the running animation without calling its onEnd (the caller cleans up). */
export function stopAnim(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  onDone = undefined;
}

export function animating(): boolean {
  return rafId !== 0;
}

/**
 * The player asked their system for less motion. Decorative animation (the
 * post-move tween) is skipped; the replay is NOT — there the motion is the
 * thing the player pressed a button for.
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function easeOutCubic(u: number): number {
  return 1 - Math.pow(1 - u, 3);
}
