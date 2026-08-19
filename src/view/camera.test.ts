import { describe, it, expect } from 'vitest';
import { fitBounds, clampToBounds, Bounds, NO_INSETS } from './camera';

// A 10×10 world box — small enough that fitBounds never hits SCALE_MAX with the
// viewports below, so the arithmetic under test is the arithmetic that runs.
const box: Bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

/** Screen x of the box's centre — where the fit claims it put the content. */
const centreX = (c: { scale: number; ox: number }) => 5 * c.scale + c.ox;

describe('fitBounds', () => {
  it('centres in the whole viewport when no chrome is in the way', () => {
    const cam = fitBounds(box, 800, 600, 0, NO_INSETS);
    expect(centreX(cam)).toBeCloseTo(400);
    expect(cam.scale).toBeCloseTo(60); // fits the tighter (vertical) axis
  });

  it('centres in the free area, so a left panel pushes the content right', () => {
    const cam = fitBounds(box, 800, 600, 0, { ...NO_INSETS, left: 200 });
    // Free area is x ∈ [200, 800]: its centre is 500, not the viewport's 400.
    expect(centreX(cam)).toBeCloseTo(500);
  });

  it('shrinks the fit when the panel makes the horizontal axis the tighter one', () => {
    // Free width 300 < height 600, so the fit is now driven by x.
    const cam = fitBounds(box, 800, 600, 0, { ...NO_INSETS, left: 500 });
    expect(cam.scale).toBeCloseTo(30);
  });

  it('takes the margin off the free area, not off the whole viewport', () => {
    const cam = fitBounds(box, 800, 600, 0.1, { ...NO_INSETS, left: 500 });
    // 10% each side of the 300px-wide free area leaves 240 for 10 cells.
    expect(cam.scale).toBeCloseTo(24);
  });
});

describe('clampToBounds', () => {
  it('keeps the content clear of a left panel instead of parking it underneath', () => {
    // Panned hard to the left: without insets this would settle at ox = 48 - 100.
    const panned = { scale: 10, ox: -5000, oy: 0 };
    const cam = clampToBounds(panned, box, 800, 600, { ...NO_INSETS, left: 200 });
    // The box's right edge (ox + 10*scale) must stay 48px inside the free area.
    expect(cam.ox + 10 * cam.scale).toBeCloseTo(248);
  });
});
