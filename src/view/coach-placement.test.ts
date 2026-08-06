import { describe, it, expect } from 'vitest';
import { placeCoach, PlaceCoachOptions, Rect } from './coach-placement';

const base: PlaceCoachOptions = {
  anchor: { x: 500, y: 400 },
  card: { w: 300, h: 90 },
  view: { w: 1000, h: 800 },
  keepOut: [],
  avoid: [],
  gap: 14,
  margin: 16,
};

/** The card as placed, for overlap assertions. */
function rect(o: PlaceCoachOptions): Rect {
  const p = placeCoach(o);
  return { x: p.left, y: p.top, w: o.card.w, h: o.card.h };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('placeCoach', () => {
  it('keeps the card inside the board whatever corner the anchor is in', () => {
    for (const anchor of [
      { x: 4, y: 4 },
      { x: 996, y: 4 },
      { x: 4, y: 796 },
      { x: 996, y: 796 },
      { x: 500, y: 400 },
    ]) {
      const r = rect({ ...base, anchor });
      expect(r.x).toBeGreaterThanOrEqual(16);
      expect(r.y).toBeGreaterThanOrEqual(16);
      expect(r.x + r.w).toBeLessThanOrEqual(1000 - 16);
      expect(r.y + r.h).toBeLessThanOrEqual(800 - 16);
    }
  });

  it('drops below an anchor near the top and above one near the bottom', () => {
    expect(placeCoach({ ...base, anchor: { x: 500, y: 60 } }).side).toBe('top');
    expect(placeCoach({ ...base, anchor: { x: 500, y: 740 } }).side).toBe('bottom');
  });

  it('stays off the chrome it was told to keep out of', () => {
    // A rail down the left and an action bar across the bottom, with the anchor
    // in the corner between them.
    const keepOut: Rect[] = [
      { x: 0, y: 0, w: 220, h: 800 },
      { x: 0, y: 720, w: 1000, h: 80 },
    ];
    const r = rect({ ...base, anchor: { x: 260, y: 700 }, keepOut });
    for (const k of keepOut) expect(overlaps(r, k)).toBe(false);
  });

  it('prefers the side clear of the track over the roomier one', () => {
    // Room says "below" (the anchor sits high), but that half is full of track.
    const avoid = [];
    for (let x = 100; x < 900; x += 10)
      for (let y = 200; y < 700; y += 10) avoid.push({ x, y });
    const p = placeCoach({ ...base, anchor: { x: 500, y: 180 }, avoid });
    expect(p.top + base.card.h).toBeLessThanOrEqual(180);
  });

  it('ignores the track right at the anchor when choosing a side', () => {
    // Road hugging the anchor on every side (unavoidable) plus a second stretch
    // below it: the choice must be made on the second one alone.
    const avoid = [];
    for (let a = 0; a < 6.28; a += 0.2)
      avoid.push({ x: 500 + 20 * Math.cos(a), y: 400 + 20 * Math.sin(a) });
    for (let x = 100; x < 900; x += 10)
      for (let y = 430; y < 700; y += 10) avoid.push({ x, y });
    const p = placeCoach({ ...base, avoid });
    expect(p.top + base.card.h).toBeLessThanOrEqual(430);
  });

  it('points the nose at the anchor, within the edge it sits on', () => {
    const p = placeCoach({ ...base, anchor: { x: 500, y: 60 } });
    expect(p.left + p.nose).toBeCloseTo(500);
    expect(p.nose).toBeGreaterThan(0);
    expect(p.nose).toBeLessThan(base.card.w);
  });

  it('keeps the nose on the card even when the anchor hugs the edge', () => {
    const p = placeCoach({ ...base, anchor: { x: 2, y: 60 } });
    expect(p.nose).toBeGreaterThanOrEqual(18);
    expect(p.nose).toBeLessThanOrEqual(base.card.w - 18);
  });
});
