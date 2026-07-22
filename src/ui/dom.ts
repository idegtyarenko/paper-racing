// Shared low-level UI primitives: pointer type detection, reliable button
// activation, and the sheet overlay. Knows nothing about game state — used by
// the panel, dialogs, and lobby.

/** Primary input is touch (phone/tablet). */
export const coarsePointer = window.matchMedia('(pointer: coarse)').matches;

const overlay = document.getElementById('overlay')!;

/** Show one overlay sheet, hiding the rest. */
export function openSheet(sheet: HTMLElement): void {
  overlay.querySelectorAll<HTMLElement>('.sheet').forEach((s) => (s.hidden = true));
  sheet.hidden = false;
  overlay.hidden = false;
}

/** Hide the overlay along with all its sheets. */
export function closeOverlay(): void {
  overlay.hidden = true;
}

/** Wire up overlay dismissal via the backdrop, `[data-close]` buttons, and Escape. */
export function bindOverlayClose(): void {
  // Only close on a backdrop tap if the press also started on the backdrop.
  // Otherwise on iOS the synthetic `click` that follows a tap which collapsed
  // a bottom-sheet hint (the sheet anchors to the bottom and slides down, so
  // the click coordinates end up above its top edge — over the backdrop)
  // would land on the backdrop and falsely close the overlay.
  const backdrop = overlay.querySelector<HTMLElement>('.overlay__backdrop')!;
  let pressedBackdrop = false;
  overlay.addEventListener('pointerdown', (e) => {
    pressedBackdrop = e.target === backdrop;
  });
  backdrop.addEventListener('click', () => {
    if (pressedBackdrop) closeOverlay();
  });
  overlay
    .querySelectorAll<HTMLElement>('[data-close]')
    .forEach((b) => bindTap(b, closeOverlay));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOverlay();
  });
}

/** Finger movement between down and up beyond this is a scroll/drag, not a tap. */
const TAP_SLOP_PX = 10;
/** Window after a touch activation during which we suppress the ghost synthetic `click`. */
const GHOST_CLICK_MS = 400;
/** Dedup: ignore a repeat firing on the same element within this window. */
const RETAP_MS = 350;
/** The ghost click lands at the tap point; beyond this radius it's a separate tap. */
const GHOST_SLOP_PX = 24;

// Global ghost-click suppressor. On a coarse pointer we activate the button on
// `pointerup`, and the browser then sends a synthetic `click` at the same point.
// A per-element window isn't enough: during the hold the panel may have
// re-rendered and swapped in a different button under the finger — that
// button's `click` isn't "its own" but a passthrough, and per-element guarding
// let it through. So a single document-level listener in the capture phase
// eats the `click` right after a touch activation at the same point — before
// it reaches the target element (including a new one now under the finger).
// Keying off coordinates, not just time, avoids suppressing a deliberate tap
// on a different button (e.g. zoom) within the same window.
let swallowClickUntil = -Infinity;
let swallowX = 0;
let swallowY = 0;
let clickSwallowInstalled = false;
function installClickSwallow(): void {
  if (clickSwallowInstalled) return;
  clickSwallowInstalled = true;
  document.addEventListener(
    'click',
    (e) => {
      const atTapPoint =
        Math.hypot(e.clientX - swallowX, e.clientY - swallowY) <= GHOST_SLOP_PX;
      if (e.timeStamp <= swallowClickUntil && atTapPoint) {
        e.stopPropagation(); // block the click from reaching any button (its own or a passthrough)
        e.preventDefault();
      }
    },
    true, // capture — intercept before it reaches the target element
  );
}

/**
 * Reliable button activation on touch screens. On iOS the first synthetic
 * `click` on a button that appeared right after a canvas gesture (e.g. "Next"
 * in the editor or "Go!" after aiming) gets dropped — the button only responds
 * on the second tap. So on a coarse pointer we activate directly on touch end
 * (`pointerup` always arrives on the first try), then globally suppress the
 * ghost `click` that follows (see `installClickSwallow`). We only count a tap
 * as a `pointerdown`+`pointerup` pair on the same element (same `pointerId`,
 * without exceeding `TAP_SLOP_PX`) — this filters out passthrough events and
 * "reverse" drags (press elsewhere, release on the button). A scroll that
 * starts from the button sends `pointercancel`, cancelling the tap. Mouse,
 * stylus, and keyboard (Enter/Space send `click` without touch) go through the
 * normal `click` path.
 *
 * Contract with `view/input.ts`: committing a move via the "Go!" button
 * depends on a `pointerup` reaching it. If a target candidate ends up under
 * the button, input.ts grabs the pointer on canvas via `setPointerCapture` on
 * `pointerdown` — then `pointerup` never reaches here and the tap doesn't
 * fire (intentional: we go into aiming rather than commit someone else's move).
 */
export function bindTap(el: HTMLElement, handler: () => void): void {
  const disabled = () => el.matches(':disabled');
  let firedAt = -Infinity;
  const fire = (ts: number) => {
    if (disabled() || ts - firedAt < RETAP_MS) return; // dedup a double tap
    firedAt = ts;
    handler();
  };
  // Mouse/stylus/keyboard. On a coarse pointer this path remains for keyboard
  // and non-touch pointers; a touch tap's own synthetic click never reaches
  // here — it gets eaten by the global capture-phase suppressor.
  el.addEventListener('click', (e) => fire(e.timeStamp));
  if (!coarsePointer) return;
  installClickSwallow();
  let downId = -1;
  let downX = 0;
  let downY = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    downId = e.pointerId;
    downX = e.clientX;
    downY = e.clientY;
  });
  el.addEventListener('pointercancel', (e) => {
    if (e.pointerId === downId) downId = -1;
  });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch' || e.pointerId !== downId) return;
    downId = -1;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > TAP_SLOP_PX) return; // scroll
    // Suppress the ghost click that will land at this point next (globally, see above).
    swallowClickUntil = e.timeStamp + GHOST_CLICK_MS;
    swallowX = e.clientX;
    swallowY = e.clientY;
    fire(e.timeStamp);
  });
}
