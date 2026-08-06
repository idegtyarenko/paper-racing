import { describe, it, expect } from 'vitest';
import { coachAvoid, placeCoach, PlaceCoachOptions, Rect } from './coach-placement';
import { EditorState } from '../model/editor';

const base: PlaceCoachOptions = {
  anchors: [{ x: 500, y: 400 }],
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

describe('coachAvoid', () => {
  it('counts the direction arrows, not just the road', () => {
    // The other arrow is what the direction step asks the player to tap, so the
    // card must not be allowed to sit on it.
    const arrow = (x: number) => ({
      from: { x, y: 0 },
      tip: { x, y: 3 },
      forward: { x: 0, y: 1 },
      path: [
        { x, y: 0 },
        { x, y: 1.5 },
        { x, y: 3 },
      ],
    });
    const ed = {
      step: 'direction',
      outer: null,
      inner: null,
      finish: { a: { x: -1, y: 0 }, b: { x: 1, y: 0 } },
      arrows: [arrow(10), arrow(20)],
    } as unknown as EditorState;
    const pts = coachAvoid(ed);
    for (const x of [10, 20])
      expect(pts.some((p) => p.x === x && p.y === 1.5)).toBe(true);
    // …and the start/finish line it sits on.
    expect(pts.some((p) => p.x === 0 && p.y === 0)).toBe(true);
  });
});

describe('placeCoach', () => {
  it('keeps the card inside the board whatever corner the anchor is in', () => {
    for (const anchor of [
      { x: 4, y: 4 },
      { x: 996, y: 4 },
      { x: 4, y: 796 },
      { x: 996, y: 796 },
      { x: 500, y: 400 },
    ]) {
      const r = rect({ ...base, anchors: [anchor] });
      expect(r.x).toBeGreaterThanOrEqual(16);
      expect(r.y).toBeGreaterThanOrEqual(16);
      expect(r.x + r.w).toBeLessThanOrEqual(1000 - 16);
      expect(r.y + r.h).toBeLessThanOrEqual(800 - 16);
    }
  });

  it('drops below an anchor near the top and above one near the bottom', () => {
    expect(placeCoach({ ...base, anchors: [{ x: 500, y: 60 }] }).side).toBe('top');
    expect(placeCoach({ ...base, anchors: [{ x: 500, y: 740 }] }).side).toBe('bottom');
  });

  it('stays off the chrome it was told to keep out of', () => {
    // A rail down the left and an action bar across the bottom, with the anchor
    // in the corner between them.
    const keepOut: Rect[] = [
      { x: 0, y: 0, w: 220, h: 800 },
      { x: 0, y: 720, w: 1000, h: 80 },
    ];
    const r = rect({ ...base, anchors: [{ x: 260, y: 700 }], keepOut });
    for (const k of keepOut) expect(overlaps(r, k)).toBe(false);
  });

  it('prefers the side clear of the track over the roomier one', () => {
    // Room says "below" (the anchor sits high), but that half is full of track.
    const avoid = [];
    for (let x = 100; x < 900; x += 10)
      for (let y = 200; y < 700; y += 10) avoid.push({ x, y });
    const p = placeCoach({ ...base, anchors: [{ x: 500, y: 180 }], avoid });
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

  it('picks the anchor whose open space the card fits into', () => {
    // A ring of road with a roomy hole in the middle: pointing at the outer edge
    // (left) would lay the card across the road, pointing at the inner one
    // (right) puts it in the hole.
    const avoid = [];
    for (let x = 200; x < 800; x += 10)
      for (let y = 300; y < 500; y += 10) if (x < 320 || x > 680) avoid.push({ x, y });
    const p = placeCoach({
      ...base,
      anchors: [
        { x: 200, y: 400 },
        { x: 320, y: 400 },
      ],
      avoid,
    });
    // Seated in the hole, pointing back at the inner edge.
    expect(p.side).toBe('left');
    expect(p.left).toBeGreaterThanOrEqual(320);
  });

  it('points the nose at the anchor, within the edge it sits on', () => {
    const p = placeCoach({ ...base, anchors: [{ x: 500, y: 60 }] });
    expect(p.left + p.nose).toBeCloseTo(500);
    expect(p.nose).toBeGreaterThan(0);
    expect(p.nose).toBeLessThan(base.card.w);
  });

  it('keeps the nose on the card even when the anchor hugs the edge', () => {
    const p = placeCoach({ ...base, anchors: [{ x: 2, y: 60 }] });
    expect(p.nose).toBeGreaterThanOrEqual(18);
    expect(p.nose).toBeLessThanOrEqual(base.card.w - 18);
  });
});
