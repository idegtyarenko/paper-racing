// Which part of the board the chrome is sitting on. Every screen's chrome
// floats over .app__board, so the canvas is always full-size while some of it
// is hidden — the framing in view/viewport.ts needs the difference, and this is
// the ui/ side of that answer: ui/ owns the selectors, view/ only ever sees
// numbers. Measured rather than derived from --pr-rail-w and the 700px
// breakpoint, so the layout stays the single source of truth for its own size.
// The rule for turning the measurements into an inset lives in left-inset.ts.

import { Insets, NO_INSETS } from '../../view/camera';
import { leftInset, Span } from './left-inset';
import { shownEl } from '../primitives/dom';

/**
 * Panels that become a side panel on a wide screen. Only opaque chrome belongs
 * here: the zoom column, the race's classification card and the action bar are
 * translucent floating HUD — the track reads fine underneath them, so taking
 * space away from it would be a downgrade.
 *
 * Being on this list is not enough to claim space — see leftInset. The same
 * elements are full-width cards on a phone, and there they must claim nothing.
 */
const LEFT_PANELS = ['.pr-nav__rail', '.pr-setup__body', '.pr-lobby__body'];

/** Board edges currently covered by opaque chrome, css px. */
export function boardInsets(): Insets {
  const board = document.querySelector('.app__board');
  if (!board) return NO_INSETS;
  const b = board.getBoundingClientRect();
  const spans: Span[] = [];
  for (const sel of LEFT_PANELS) {
    const el = shownEl(sel);
    if (!el) continue;
    // A panel on a hidden screen measures 0×0, so phase gating needs no test of
    // its own — an off-screen panel simply claims nothing.
    const r = el.getBoundingClientRect();
    if (r.width && r.height)
      spans.push({ left: r.left - b.left, right: r.right - b.left });
  }
  return { ...NO_INSETS, left: leftInset(spans, b.width) };
}
