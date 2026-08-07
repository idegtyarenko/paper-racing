import { describe, it, expect } from 'vitest';
import { Vec } from '../geometry';
import { TrailSeg } from '../model/game';
import { computeLanes, clipLaneStops, LaneStop, LANE_DEFAULTS } from './trail-lanes';

/** Trail from a run of points: p0->p1->p2... all normal (non-jump) moves. */
const chain = (...pts: Vec[]): TrailSeg[] =>
  pts.slice(1).map((p, i) => ({ from: pts[i], to: p, jump: false, turn: i }));

const at = (stops: LaneStop[], t: number): number => {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].t) {
      const a = stops[i - 1];
      const b = stops[i];
      const d = b.t - a.t;
      return d <= 0 ? b.offset : a.offset + ((b.offset - a.offset) * (t - a.t)) / d;
    }
  }
  return stops[stops.length - 1].offset;
};

const STEP = LANE_DEFAULTS.step;

describe('computeLanes', () => {
  it('leaves trails alone when nobody overlaps (the starting grid)', () => {
    // Six cars, each on its own row, all driving straight — the case that
    // regressed: they were all displaced despite never sharing a line.
    const trails = [0, 1, 2, 3, 4, 5].map((y) =>
      chain({ x: 19, y }, { x: 20, y }, { x: 22, y }),
    );
    for (const player of computeLanes(trails)) {
      for (const seg of player) {
        for (const stop of seg) expect(stop.offset).toBe(0);
      }
    }
  });

  it('splits two cars sharing a line into opposite lanes', () => {
    const trails = [
      chain({ x: 10, y: 4 }, { x: 30, y: 4 }),
      chain({ x: 10, y: 4 }, { x: 30, y: 4 }),
    ];
    const [a, b] = computeLanes(trails);
    expect(Math.abs(at(a[0], 0.5))).toBeCloseTo(STEP / 2, 6);
    // Opposite sides, so exactly one step apart.
    expect(at(a[0], 0.5) + at(b[0], 0.5)).toBeCloseTo(0, 6);
    expect(Math.abs(at(a[0], 0.5) - at(b[0], 0.5))).toBeCloseTo(STEP, 6);
  });

  it('offsets only the overlapping stretch, not the whole trail', () => {
    // A runs x=10..30; B only x=15..25. Only the middle is contested.
    const trails = [
      chain({ x: 10, y: 4 }, { x: 30, y: 4 }),
      chain({ x: 15, y: 4 }, { x: 25, y: 4 }),
    ];
    const [a] = computeLanes(trails);
    expect(at(a[0], 0.1)).toBeCloseTo(0, 6); // x=12, alone
    expect(Math.abs(at(a[0], 0.5))).toBeCloseTo(STEP / 2, 6); // x=20, contested
    expect(at(a[0], 0.9)).toBeCloseTo(0, 6); // x=28, alone
  });

  it('keeps the offset continuous across shared nodes', () => {
    // A gap at a node would tear the ribbon open, so this is the invariant
    // that matters most for rendering.
    const trails = [
      chain({ x: 10, y: 4 }, { x: 14, y: 4 }, { x: 20, y: 4 }, { x: 24, y: 6 }),
      chain({ x: 12, y: 4 }, { x: 18, y: 4 }, { x: 22, y: 4 }),
    ];
    for (const player of computeLanes(trails)) {
      for (let i = 0; i + 1 < player.length; i++) {
        expect(at(player[i], 1)).toBeCloseTo(at(player[i + 1], 0), 9);
      }
    }
  });

  it('caps the total spread when many cars share one line', () => {
    const trails = [0, 1, 2, 3, 4, 5].map(() => chain({ x: 10, y: 4 }, { x: 30, y: 4 }));
    const mid = computeLanes(trails).map((p) => at(p[0], 0.5));
    expect(Math.max(...mid) - Math.min(...mid)).toBeLessThanOrEqual(
      LANE_DEFAULTS.maxSpread + 1e-9,
    );
    // Still six distinct lanes.
    expect(new Set(mid.map((v) => v.toFixed(6))).size).toBe(6);
  });

  it('detects overlap regardless of travel direction', () => {
    const trails = [
      chain({ x: 10, y: 4 }, { x: 30, y: 4 }),
      chain({ x: 30, y: 4 }, { x: 10, y: 4 }),
    ];
    const [a, b] = computeLanes(trails);
    expect(Math.abs(at(a[0], 0.5))).toBeCloseTo(STEP / 2, 6);
    expect(Math.abs(at(b[0], 0.5))).toBeCloseTo(STEP / 2, 6);
  });

  it('ignores paths that merely cross at an angle', () => {
    const trails = [
      chain({ x: 10, y: 4 }, { x: 20, y: 4 }),
      chain({ x: 15, y: 0 }, { x: 15, y: 10 }),
    ];
    for (const player of computeLanes(trails)) {
      for (const seg of player) for (const stop of seg) expect(stop.offset).toBe(0);
    }
  });

  it('returns to the true path at both ends of a chain', () => {
    // The car marker and the start node sit on the true lattice point, so the
    // trail has to arrive there rather than beside it.
    const trails = [
      chain({ x: 10, y: 4 }, { x: 30, y: 4 }),
      chain({ x: 10, y: 4 }, { x: 30, y: 4 }),
    ];
    for (const player of computeLanes(trails)) {
      expect(at(player[0], 0)).toBeCloseTo(0, 9);
      expect(at(player[player.length - 1], 1)).toBeCloseTo(0, 9);
    }
  });

  it('never offsets jump segments', () => {
    const trails = [
      [
        ...chain({ x: 10, y: 4 }, { x: 20, y: 4 }),
        { from: { x: 20, y: 4 }, to: { x: 22, y: 6 }, jump: true, turn: 1 },
        ...chain({ x: 22, y: 6 }, { x: 26, y: 6 }),
      ],
      chain({ x: 10, y: 4 }, { x: 20, y: 4 }),
    ];
    const [a] = computeLanes(trails);
    for (const stop of a[1]) expect(stop.offset).toBe(0);
  });

  it('handles a standing car (zero-length segment)', () => {
    const trails = [
      [
        ...chain({ x: 10, y: 4 }, { x: 20, y: 4 }),
        { from: { x: 20, y: 4 }, to: { x: 20, y: 4 }, jump: false, turn: 1 },
      ],
      chain({ x: 10, y: 4 }, { x: 20, y: 4 }),
    ];
    const lanes = computeLanes(trails);
    expect(lanes[0][1].every((s) => s.offset === 0)).toBe(true);
  });
});

describe('clipLaneStops', () => {
  const stops: LaneStop[] = [
    { t: 0, offset: 0 },
    { t: 0.5, offset: 0.2 },
    { t: 1, offset: 0.2 },
  ];

  it('leaves a whole segment alone', () => {
    expect(clipLaneStops(stops, 1)).toBe(stops);
  });

  it('rescales the kept stops to the shorter segment', () => {
    // Cut at 0.5: the ramp's midpoint stop becomes this segment's end.
    const cut = clipLaneStops(stops, 0.5);
    expect(cut[cut.length - 1]).toEqual({ t: 1, offset: 0.2 });
    expect(cut[0]).toEqual({ t: 0, offset: 0 });
  });

  it('interpolates the offset at the cut', () => {
    const cut = clipLaneStops(stops, 0.25);
    expect(cut[cut.length - 1].t).toBe(1);
    expect(cut[cut.length - 1].offset).toBeCloseTo(0.1); // halfway up the ramp
  });

  it('a car that has not moved yet keeps a single stop', () => {
    expect(clipLaneStops(stops, 0)).toEqual([{ t: 0, offset: 0 }]);
  });
});
