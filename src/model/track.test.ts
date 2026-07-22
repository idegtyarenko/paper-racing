import { describe, it, expect } from 'vitest';
import { Vec, Polyline, distPointToSegment } from '../geometry';
import { strings } from '../i18n';
import {
  onRoad,
  sideOfFinish,
  processStroke,
  clipFinishLine,
  finalizeTrack,
  layoutStartGrid,
  StartCandidate,
} from './track';
import { OUTER, INNER, FINISH, FORWARD, ringTrack } from './test-fixtures';
import {
  MIN_ROAD_CELLS,
  MAX_START_POINTS,
  START_ROW_MAX,
  START_SEED_TOL,
} from '../config';

describe('onRoad', () => {
  it('a point inside the ring is on the road; inside the hole or outside is not', () => {
    expect(onRoad({ x: 10, y: 4 }, OUTER, INNER)).toBe(true);
    expect(onRoad({ x: 20, y: 12 }, OUTER, INNER)).toBe(false); // inside the inner hole
    expect(onRoad({ x: 50, y: 50 }, OUTER, INNER)).toBe(false); // outside the outer boundary
  });
});

describe('sideOfFinish', () => {
  it('the sign matches the race direction (forward = +x, finish at x=6)', () => {
    const t = { finish: FINISH, forward: FORWARD };
    expect(sideOfFinish(t, { x: 10, y: 4 })).toBeGreaterThan(0);
    expect(sideOfFinish(t, { x: 2, y: 4 })).toBeLessThan(0);
  });
});

describe('processStroke', () => {
  it('fewer than 8 points → "stroke too short" error', () => {
    const res = processStroke([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 0 },
      { x: 3, y: 1 },
      { x: 2, y: 2 },
    ]);
    expect(res).toEqual({ error: strings.track.strokeShort });
  });

  it('a tiny stroke (diagonal < 4) → "stroke too short" error', () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({
      x: Math.cos(i) * 0.5,
      y: Math.sin(i) * 0.5,
    }));
    expect(processStroke(raw)).toEqual({ error: strings.track.strokeShort });
  });

  it('an unclosed stroke (endpoints far apart) → "not closed" error', () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({ x: i * 2, y: 0 }));
    expect(processStroke(raw)).toEqual({ error: strings.track.notClosed });
  });

  it('a valid closed loop → a smoothed polyline', () => {
    const raw = Array.from({ length: 16 }, (_, i) => {
      const a = (i / 16) * Math.PI * 2;
      return { x: 10 + Math.cos(a) * 5, y: 10 + Math.sin(a) * 5 };
    });
    const res = processStroke(raw);
    expect('poly' in res).toBe(true);
    if ('poly' in res) expect(res.poly.length).toBeGreaterThan(10);
  });
});

describe('clipFinishLine', () => {
  it('a drag across the road → a finish line extended out past the walls', () => {
    // Drag on the bottom straight (x=20, where there's an inner wall at y=8).
    const res = clipFinishLine({ x: 20, y: -1 }, { x: 20, y: 3 }, OUTER, INNER);
    expect('finish' in res).toBe(true);
    if ('finish' in res) {
      // Bottom straight: outer y=0, inner y=8 → endpoints ≈ (20,-0.25) and (20,8.25).
      expect(res.finish.a.y).toBeCloseTo(-0.25);
      expect(res.finish.b.y).toBeCloseTo(8.25);
    }
  });

  it('a drag past the road (through the hole) → no-cross', () => {
    const res = clipFinishLine({ x: 20, y: 12 }, { x: 20, y: 13 }, OUTER, INNER);
    expect(res).toEqual({ error: 'no-cross' });
  });

  it('a drag across a road that is too narrow → narrow', () => {
    // Narrow bridge at the top: gap outer(y=10) − inner(y=9.5) = 0.5 < 1.
    const outer: Polyline = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const inner: Polyline = [
      { x: 1, y: 1 },
      { x: 9, y: 1 },
      { x: 9, y: 9.5 },
      { x: 1, y: 9.5 },
    ];
    const res = clipFinishLine({ x: 5, y: 9 }, { x: 5, y: 11 }, outer, inner);
    expect(res).toEqual({ error: 'narrow' });
  });
});

describe('finalizeTrack', () => {
  it('a valid ring → a track with a road and starting positions', () => {
    const res = finalizeTrack(OUTER, INNER, FINISH, FORWARD);
    expect('track' in res).toBe(true);
    if ('track' in res) {
      expect(res.track.inside.size).toBeGreaterThanOrEqual(MIN_ROAD_CELLS);
      expect(res.track.startPoints.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('starting positions are ordered from closest to the finish (pole is index 0)', () => {
    const t = ringTrack();
    const d = (p: Vec) => Math.abs(p.x - 6); // distance to the line x=6
    for (let i = 1; i < t.startPoints.length; i++) {
      expect(d(t.startPoints[i])).toBeGreaterThanOrEqual(d(t.startPoints[i - 1]) - 1e-9);
    }
  });

  it('starting positions form a centered grid: minimum rows, not pressed to the edges', () => {
    // Bottom straight: road spans y≈1..7, center y=4. Starts hug the center (not the
    // sides) and pack into the minimum number of rows: 6 cars = 2 rows of 3 (only 1 cell deep).
    const t = ringTrack();
    expect(t.startPoints.length).toBe(MAX_START_POINTS);
    for (const p of t.startPoints) {
      expect(Math.abs(p.y - 4)).toBeLessThanOrEqual(1); // close to center, not against the walls
    }
    expect(new Set(t.startPoints.map((p) => p.y)).size).toBeLessThanOrEqual(
      START_ROW_MAX,
    );
    // Depth: no more than ceil(6/3)=2 rows (rows differ by x in this fixture).
    expect(new Set(t.startPoints.map((p) => p.x)).size).toBeLessThanOrEqual(2);
  });

  it('a distant segment on the same half-plane does not become a starting position', () => {
    // Regression: on an S-curve the infinite finish line also slices through distant
    // segments of the track, so the old logic (behind = the entire half-plane
    // sideOfFinish<0) could seat a car in the middle of the lap. Here the track is a
    // "staple"-shaped corridor (a C open to the left): a bottom arm at the line + a
    // right arm (going up) + a top arm. The finish is a short vertical segment at the
    // left end of the bottom arm, race direction +x. The half-plane x<3 also captures
    // both the narrow start below (y≈1..2) and the DISTANT top arm (y≈22..23): it's past
    // the line in x, but the only way to reach it is around (the right arm is not
    // "behind"), i.e. in the "backward nodes only" graph it's disconnected.
    const outer: Polyline = [
      { x: 0, y: 0 },
      { x: 32, y: 0 },
      { x: 32, y: 24 },
      { x: 0, y: 24 },
    ];
    const inner: Polyline = [
      { x: -2, y: 3 },
      { x: 27, y: 3 },
      { x: 27, y: 21 },
      { x: -2, y: 21 },
    ];
    const finish = { a: { x: 3, y: 0 }, b: { x: 3, y: 3 } };
    const forward: Vec = { x: 1, y: 0 };
    const res = finalizeTrack(outer, inner, finish, forward);
    expect('track' in res).toBe(true);
    if (!('track' in res)) return;
    const t = res.track;
    // Trap premise: the distant top arm genuinely lies within the half-plane
    // (otherwise this test guards nothing).
    const farBehindExists = [...t.inside]
      .map((k) => {
        const x = Math.floor(k / 4096) - 128;
        const y = (k % 4096) - 128;
        return { x, y };
      })
      .some((p) => p.y >= 21 && sideOfFinish({ finish, forward }, p) < -1e-9);
    expect(farBehindExists).toBe(true);
    // All starting positions are near the bottom line, none "teleported" to the top arm.
    expect(t.startPoints.length).toBeGreaterThanOrEqual(2);
    for (const p of t.startPoints) expect(p.y).toBeLessThan(10);
  });

  it('a hairpin right behind the line — starts hug the line, none pushed onto the far arm', () => {
    // A hairpin-shaped road (U, open to the right): a bottom arm y≈0..3 and a top arm
    // y≈4..7, joined on the left (x≈0..4). The finish crosses the bottom arm on the
    // right (x=16), race direction +x (cars exit the throat of the U). Behind the
    // line the corridor runs left, turns 180°, and comes back right along the top arm.
    // The right end of the top arm (15,5..6) is physically close to the line, but by
    // corridor distance it's on the far lap (depth ~25). The old straight-axis logic
    // (sorting by straight-line "backward" projection) would have seated 2 cars there;
    // the corridor-based logic keeps everyone in a tight cluster right at the line.
    const outer: Polyline = [
      { x: 0, y: 0 },
      { x: 18, y: 0 },
      { x: 18, y: 3 },
      { x: 4, y: 3 },
      { x: 4, y: 4 },
      { x: 18, y: 4 },
      { x: 18, y: 7 },
      { x: 0, y: 7 },
    ];
    const inner: Polyline = [
      { x: 100, y: 100 },
      { x: 101, y: 100 },
      { x: 101, y: 101 },
      { x: 100, y: 101 },
    ];
    const finish = { a: { x: 16, y: 0 }, b: { x: 16, y: 3 } };
    const forward: Vec = { x: 1, y: 0 };
    const res = finalizeTrack(outer, inner, finish, forward);
    expect('track' in res).toBe(true);
    if (!('track' in res)) return;
    const t = res.track;
    expect(t.startPoints.length).toBe(MAX_START_POINTS);

    // Compute each node's corridor depth with the same BFS finalizeTrack uses: seeds
    // are the backward nodes next to the finish segment, wave spreads 8-connected
    // only through backward road nodes.
    const nodes = [...t.inside].map((k) => ({
      x: Math.floor(k / 4096) - 128,
      y: (k % 4096) - 128,
    }));
    const behind = new Set(
      nodes
        .filter((p) => sideOfFinish({ finish, forward }, p) < -1e-9)
        .map((p) => `${p.x},${p.y}`),
    );
    const corridor = new Map<string, number>();
    const queue: Vec[] = [];
    nodes.forEach((p) => {
      if (!behind.has(`${p.x},${p.y}`)) return;
      if (distPointToSegment(p, finish.a, finish.b) <= START_SEED_TOL) {
        corridor.set(`${p.x},${p.y}`, 0);
        queue.push(p);
      }
    });
    for (let h = 0; h < queue.length; h++) {
      const p = queue[h];
      const d = corridor.get(`${p.x},${p.y}`)!;
      for (const [dx, dy] of [
        [-1, -1],
        [-1, 0],
        [-1, 1],
        [0, -1],
        [0, 1],
        [1, -1],
        [1, 0],
        [1, 1],
      ]) {
        const q = { x: p.x + dx, y: p.y + dy };
        const kq = `${q.x},${q.y}`;
        if (corridor.has(kq) || !behind.has(kq)) continue;
        corridor.set(kq, d + 1);
        queue.push(q);
      }
    }

    // (a) Compactness: all starts are in the shallowest corridor layers (6 cars ≤
    // ceil(6/3)=2 rows, +1 margin), no one pushed deep in.
    const maxCorridor = Math.ceil(MAX_START_POINTS / START_ROW_MAX) + 1;
    for (const p of t.startPoints) {
      const d = corridor.get(`${p.x},${p.y}`);
      expect(d).toBeDefined();
      expect(d!).toBeLessThanOrEqual(maxCorridor);
    }
    // (b) No starting position is stranded on the top (corridor-distant) arm of the hairpin.
    for (const p of t.startPoints) expect(p.y).toBeLessThan(4);
    // (c) Starts form a single 8-connected cluster (no "teleported" nodes).
    const sset = new Set(t.startPoints.map((p) => `${p.x},${p.y}`));
    const seen = new Set<string>();
    const stack = [t.startPoints[0]];
    seen.add(`${t.startPoints[0].x},${t.startPoints[0].y}`);
    while (stack.length) {
      const p = stack.pop()!;
      for (const [dx, dy] of [
        [-1, -1],
        [-1, 0],
        [-1, 1],
        [0, -1],
        [0, 1],
        [1, -1],
        [1, 0],
        [1, 1],
      ]) {
        const kq = `${p.x + dx},${p.y + dy}`;
        if (sset.has(kq) && !seen.has(kq)) {
          seen.add(kq);
          stack.push({ x: p.x + dx, y: p.y + dy });
        }
      }
    }
    expect(seen.size).toBe(t.startPoints.length);
  });

  it('a ring that is too tight → error', () => {
    const outer: Polyline = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];
    const inner: Polyline = [
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 3 },
      { x: 1, y: 3 },
    ];
    const res = finalizeTrack(outer, inner, FINISH, FORWARD);
    expect('error' in res).toBe(true);
  });
});

describe('layoutStartGrid', () => {
  // Finish crosses at (a=(6,0),b=(6,8)), race direction +x: for a point back = 6−x, lat = y−4.
  // Along these axis-aligned lines, corridor depth equals the integer backward offset: corridor = 6−x.
  const finish = { a: { x: 6, y: 0 }, b: { x: 6, y: 8 } };
  const forward: Vec = { x: 1, y: 0 };
  const backOf = (p: Vec) => 6 - p.x;
  const cand = (p: Vec): StartCandidate => ({ p, corridor: 6 - p.x });

  it('a wide zone → a centered grid ≤ MAX, ordered front to back', () => {
    const behind: StartCandidate[] = [];
    for (let x = 1; x <= 5; x++) for (let y = 1; y <= 7; y++) behind.push(cand({ x, y }));
    const grid = layoutStartGrid(finish, forward, behind);
    expect(grid.length).toBe(MAX_START_POINTS);
    // Ordered by increasing backward offset.
    for (let i = 1; i < grid.length; i++) {
      expect(backOf(grid[i])).toBeGreaterThanOrEqual(backOf(grid[i - 1]) - 1e-9);
    }
    // Hug the center (y=4), not the edges; rows no wider than START_ROW_MAX.
    for (const p of grid) expect(Math.abs(p.y - 4)).toBeLessThanOrEqual(1);
    expect(new Set(grid.map((p) => p.y)).size).toBeLessThanOrEqual(START_ROW_MAX);
    // Minimum depth: 6 cars = 2 rows (by x), no more.
    expect(new Set(grid.map((p) => backOf(p))).size).toBeLessThanOrEqual(2);
    // The first row is filled up to START_ROW_MAX right on the line — small grids
    // (2-3 cars taking the front slots) start with no depth at all.
    const front = grid.slice(0, START_ROW_MAX).map(backOf);
    expect(new Set(front).size).toBe(1);
    // No repeated cells.
    expect(new Set(grid.map((p) => `${p.x},${p.y}`)).size).toBe(grid.length);
  });

  it('a single column of nodes → lined up single-file, everyone seated', () => {
    // A single cross row y=4 (a narrow starting area): the grid degenerates to a
    // single line, but all candidates are still seated in depth order.
    const behind: StartCandidate[] = [1, 2, 3, 4, 5].map((x) => cand({ x, y: 4 }));
    const grid = layoutStartGrid(finish, forward, behind);
    expect(grid.length).toBe(5);
    expect(grid.every((p) => p.y === 4)).toBe(true);
    expect(grid.map((p) => p.x)).toEqual([5, 4, 3, 2, 1]); // front (closer to the line) to back
  });

  it('only two cells → both become starting positions', () => {
    const behind: StartCandidate[] = [cand({ x: 5, y: 4 }), cand({ x: 4, y: 4 })];
    expect(layoutStartGrid(finish, forward, behind)).toHaveLength(2);
  });

  it('corridor distance beats straight-line projection: a corridor-distant node does not get pole', () => {
    // The trap: a node with a small straight-line back offset but large corridor depth
    // (on a distant lap past a kink). The old straight-axis logic would have seated it
    // up front; the corridor-based logic picks the genuinely nearest central node.
    const behind: StartCandidate[] = [
      { p: { x: 5, y: 4 }, corridor: 1 }, // true pole: right behind the line, centered
      { p: { x: 5, y: 1 }, corridor: 9 }, // same straight-line back (x=5), but far by corridor
    ];
    const grid = layoutStartGrid(finish, forward, behind);
    expect(grid[0]).toEqual({ x: 5, y: 4 });
  });
});
