// The rule for how much of the board's left edge the chrome shell covers.
// Split out from board-insets.ts, which does the measuring: this half is pure
// arithmetic over spans, so it can be tested in the node environment the rest
// of the suite runs in (board-insets.ts reaches for document).

/** How far off the edge a panel may start and still count as flush with it. */
const EDGE_TOL = 1;

/**
 * Past this share of the board a panel isn't a side panel any more, it's a
 * full-screen overlay — framing the track into the leftover sliver is worse
 * than ignoring the panel and letting it cover the middle.
 */
const MAX_INSET_FRAC = 0.6;

/** A panel's horizontal extent in board-local css px. */
export interface Span {
  left: number;
  right: number;
}

/**
 * How much of the board's left edge the chrome shell covers, given every shown
 * panel's horizontal span.
 *
 * Walks outwards from the edge instead of taking the widest right edge: a panel
 * counts only if it starts at the edge or butts against what has already been
 * claimed — the setup screen's panel begins exactly where the step rail ends,
 * and the two read as one shell. On a phone these same elements are cards with
 * a gutter down both sides; they touch nothing at the edge, so they claim
 * nothing and the track gets the whole board.
 */
export function leftInset(panels: Span[], boardW: number): number {
  let left = 0;
  for (let grew = true; grew;) {
    grew = false;
    for (const p of panels) {
      if (p.left <= left + EDGE_TOL && p.right > left) {
        left = p.right;
        grew = true;
      }
    }
  }
  return left > boardW * MAX_INSET_FRAC ? 0 : left;
}
