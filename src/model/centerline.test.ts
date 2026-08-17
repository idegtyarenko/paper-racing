// Track generation from a centerline: the road must never come out narrower than a
// car can be navigated through.
//
// The invariant under test is not "the road looks wide enough" but a hard one about
// the lattice: a node counts as road only when it is further than WALL_CLEARANCE from
// both walls (isRoadLatticePoint in track.ts), while the engine lets a car drive until
// it is OFFROAD_FORGIVE PAST a wall. Where a neck is tight enough that no node survives,
// the road lattice is cut in two — buildNavField's BFS then never reaches the stretch
// right after the finish line, bots lose their distance-to-finish gradient there and
// mill around at the start, while a human drives through the same neck without noticing
// (a move may fly over it). That was the bug this file was written for.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateEdges, rebuildEdges, applyEdgeDrag, WidthModel } from './centerline';
import { processStroke, finalizeTrack, clipFinishLine } from './track';
import { buildNavField } from './nav';
import { Vec, Polyline, add, sub, scale, distPointToPolyline } from '../geometry';
import { ROAD_MIN } from '../config';

/** Deterministic Math.random, so the random width profile doesn't make tests flaky. */
function seedRandom(seed: number): void {
  let a = seed;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A "paperclip": two nearly parallel arms `gap` apart, joined by hairpins. The closer
 * the arms, the harder the generator has to squeeze the road between the two passes —
 * this is the shape that used to produce an unnavigable neck.
 */
function paperclip(gap: number): Vec[] {
  const pts: Vec[] = [];
  const L = 40;
  const R = gap / 2;
  for (let i = 0; i <= 60; i++) pts.push({ x: 40 + (L * i) / 60, y: 70 - R });
  for (let i = 1; i < 30; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / 30;
    pts.push({ x: 40 + L + R * Math.cos(a), y: 70 + R * Math.sin(a) });
  }
  for (let i = 0; i <= 60; i++) pts.push({ x: 40 + L - (L * i) / 60, y: 70 + R });
  for (let i = 1; i < 30; i++) {
    const a = Math.PI / 2 + (Math.PI * i) / 30;
    pts.push({ x: 40 + R * Math.cos(a), y: 70 + R * Math.sin(a) });
  }
  return pts;
}

/** A rounded wobbly loop — the ordinary case, which must keep on generating fine. */
function wobblyLoop(seed: number): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * Math.PI * 2;
    const r = 28 + 6 * Math.sin(a * 5 + seed) + 4 * Math.sin(a * 2 + seed * 2);
    pts.push({ x: 70 + r * Math.cos(a), y: 70 + r * Math.sin(a) });
  }
  return pts;
}

/** Narrowest place of the road, measured on the FINAL edges (after smoothing). */
function minRoadWidth(outer: Polyline, inner: Polyline): number {
  let min = Infinity;
  for (const p of outer) min = Math.min(min, distPointToPolyline(p, inner));
  for (const p of inner) min = Math.min(min, distPointToPolyline(p, outer));
  return min;
}

type Built = { model: WidthModel; outer: Polyline; inner: Polyline };

/** Run a stroke through the editor's real pipeline. Returns null when the generator
 *  refuses the drawing — a legitimate outcome, just not a track. */
function build(stroke: Vec[]): Built | null {
  const st = processStroke(stroke);
  if ('error' in st) return null;
  const res = generateEdges(st.poly);
  return 'error' in res ? null : res;
}

/** Finish line across the road at a centerline vertex, plus the resulting track. */
function trackFrom(b: Built, at = 0.1) {
  const i = Math.floor(b.model.center.length * at);
  const c = b.model.center[i];
  const nrm = b.model.outNormal[i];
  const fin = clipFinishLine(
    sub(c, scale(nrm, 8)),
    add(c, scale(nrm, 8)),
    b.outer,
    b.inner,
  );
  if ('error' in fin) return null;
  const res = finalizeTrack(b.outer, b.inner, fin.finish, { x: -nrm.y, y: nrm.x });
  return 'error' in res ? null : res.track;
}

const GAPS = [2.6, 3, 3.5, 4, 4.5, 5, 6];

describe('generated road width', () => {
  it('never comes out narrower than ROAD_MIN, however tight the drawing', () => {
    const narrow: string[] = [];
    for (const gap of GAPS) {
      seedRandom(gap * 1000);
      const b = build(paperclip(gap));
      if (!b) continue; // the generator refused the drawing — fine, just not a track
      const w = minRoadWidth(b.outer, b.inner);
      if (w < ROAD_MIN) narrow.push(`gap ${gap}: ${w.toFixed(2)}`);
    }
    expect(narrow).toEqual([]);
  });

  it('still builds ordinary rounded loops', () => {
    const built = [0, 1, 2, 3, 4, 5].filter((s) => {
      seedRandom(s);
      return build(wobblyLoop(s)) !== null;
    });
    expect(built.length).toBe(6);
  });
});

describe('road lattice stays connected', () => {
  // The real payload: with a hole in the lattice, buildNavField cannot reach the road
  // past the cut, and every car beyond it is navigating blind.
  it('leaves no road node without a distance to the finish', () => {
    const holes: string[] = [];
    for (const gap of GAPS) {
      seedRandom(gap * 1000);
      const b = build(paperclip(gap));
      if (!b) continue;
      const track = trackFrom(b);
      if (!track) continue;
      const nav = buildNavField(track);
      let unreached = 0;
      track.inside.forEach((k) => {
        if (!nav.dist.has(k)) unreached++;
      });
      if (unreached > 0) holes.push(`gap ${gap}: ${unreached} of ${track.inside.size}`);
    }
    expect(holes).toEqual([]);
  });
});

describe('dragging an edge', () => {
  it('runs up against ROAD_MIN instead of pinching the road shut', () => {
    seedRandom(7);
    const b = build(wobblyLoop(0));
    expect(b).not.toBeNull();
    const m = b!.model;
    const j = Math.floor(m.center.length * 0.6);
    // Drag the inner edge right onto the outer one, then the outer onto the inner:
    // the strongest pinch the UI allows at that vertex.
    applyEdgeDrag(m, 'inner', j, rebuildEdges(m).outer[j]);
    applyEdgeDrag(m, 'outer', j, rebuildEdges(m).inner[j]);
    const { outer, inner } = rebuildEdges(m);
    expect(minRoadWidth(outer, inner)).toBeGreaterThanOrEqual(ROAD_MIN);
  });
});
