import { describe, it, expect } from 'vitest';
import { leftInset, Span } from './left-inset';

// Board widths from the two layouts this has to tell apart.
const WIDE = 1512;
const PHONE = 430;
const GUTTER = 16; // --pr-gutter

describe('leftInset', () => {
  it('claims nothing when no panel is on screen (the race)', () => {
    expect(leftInset([], WIDE)).toBe(0);
  });

  it('takes the step rail on the wide editor', () => {
    expect(leftInset([{ left: 0, right: 220 }], WIDE)).toBe(220);
  });

  it('follows the shell across a contiguous panel (rail + setup panel)', () => {
    // The setup panel starts exactly where the rail ends — one shell, not two.
    const panels: Span[] = [
      { left: 0, right: 220 },
      { left: 220, right: 620 },
    ];
    expect(leftInset(panels, WIDE)).toBe(620);
  });

  it('does not care what order the panels come in', () => {
    const panels: Span[] = [
      { left: 220, right: 620 },
      { left: 0, right: 220 },
    ];
    expect(leftInset(panels, WIDE)).toBe(620);
  });

  it('ignores a full-width card with a gutter, so a phone keeps the whole board', () => {
    // The lobby on a phone is left:16 / right:16. Taking its right edge would
    // squeeze the track into the 16px strip left over at the far side.
    expect(leftInset([{ left: GUTTER, right: PHONE - GUTTER }], PHONE)).toBe(0);
  });

  it('ignores a panel flush with the edge that still swallows the board', () => {
    // Flush left but nearly full width — an overlay, not a side panel.
    expect(leftInset([{ left: 0, right: PHONE - GUTTER }], PHONE)).toBe(0);
  });

  it('ignores a panel that floats free of the left edge', () => {
    expect(leftInset([{ left: 300, right: 700 }], WIDE)).toBe(0);
  });
});
