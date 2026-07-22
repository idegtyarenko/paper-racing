import { describe, it, expect } from 'vitest';
import {
  Polyline,
  segSegIntersection,
  pointOnSegment,
  closestPointOnSegment,
  distPointToSegment,
  distPointToPolyline,
  pointInPolygon,
  signedArea,
  polygonArea,
  selfIntersectsClosed,
  closedNormals,
  len,
  resampleClosed,
  chaikinClosed,
} from './geometry';

// CCW 4×4 square (standard orientation, y up): signedArea > 0.
const SQUARE: Polyline = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 4, y: 4 },
  { x: 0, y: 4 },
];

describe('segSegIntersection', () => {
  it('finds the clean intersection point and parameter t along the first segment', () => {
    const hit = segSegIntersection(
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 2, y: -2 },
      { x: 2, y: 2 },
    );
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(0.5);
    expect(hit!.point.x).toBeCloseTo(2);
    expect(hit!.point.y).toBeCloseTo(0);
  });

  it('parallel, non-intersecting (not collinear) → null', () => {
    expect(
      segSegIntersection({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 1 }, { x: 4, y: 1 }),
    ).toBeNull();
  });

  it('collinear overlap → start of the shared portion', () => {
    const hit = segSegIntersection(
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 2, y: 0 },
      { x: 6, y: 0 },
    );
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(2);
  });

  it('touching at endpoints counts as an intersection', () => {
    const hit = segSegIntersection(
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
    );
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(1);
  });

  it('a degenerate first segment → null', () => {
    expect(
      segSegIntersection({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 0 }, { x: 2, y: 2 }),
    ).toBeNull();
  });
});

describe('pointOnSegment', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 4, y: 0 };
  it('an interior point and the endpoints are on the segment', () => {
    expect(pointOnSegment({ x: 2, y: 0 }, a, b)).toBe(true);
    expect(pointOnSegment(a, a, b)).toBe(true);
    expect(pointOnSegment(b, a, b)).toBe(true);
  });
  it('collinear but out of range is not on the segment', () => {
    expect(pointOnSegment({ x: 5, y: 0 }, a, b)).toBe(false);
    expect(pointOnSegment({ x: -1, y: 0 }, a, b)).toBe(false);
  });
  it('off the line is not on the segment', () => {
    expect(pointOnSegment({ x: 2, y: 1 }, a, b)).toBe(false);
  });
});

describe('closestPointOnSegment / distPointToSegment', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 4, y: 0 };
  it('drops a perpendicular to the midpoint', () => {
    const c = closestPointOnSegment({ x: 2, y: 5 }, a, b);
    expect(c.x).toBeCloseTo(2);
    expect(c.y).toBeCloseTo(0);
    expect(distPointToSegment({ x: 2, y: 5 }, a, b)).toBeCloseTo(5);
  });
  it('clamps to the endpoints', () => {
    expect(closestPointOnSegment({ x: -3, y: 1 }, a, b)).toEqual({ x: 0, y: 0 });
    expect(closestPointOnSegment({ x: 9, y: 1 }, a, b)).toEqual({ x: 4, y: 0 });
  });
});

describe('pointInPolygon', () => {
  it('inside / outside the square', () => {
    expect(pointInPolygon({ x: 2, y: 2 }, SQUARE)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 5 }, SQUARE)).toBe(false);
    expect(pointInPolygon({ x: -1, y: 2 }, SQUARE)).toBe(false);
  });
});

describe('distPointToPolyline', () => {
  it('distance to the nearest edge', () => {
    expect(distPointToPolyline({ x: 2, y: 2 }, SQUARE)).toBeCloseTo(2);
    expect(distPointToPolyline({ x: 2, y: 6 }, SQUARE)).toBeCloseTo(2);
  });
});

describe('signedArea / polygonArea', () => {
  it('the sign encodes winding direction (CCW > 0)', () => {
    expect(signedArea(SQUARE)).toBeGreaterThan(0);
    expect(signedArea([...SQUARE].reverse())).toBeLessThan(0);
  });
  it('polygonArea is the absolute value of the signed area', () => {
    expect(polygonArea(SQUARE)).toBeCloseTo(16);
    expect(polygonArea([...SQUARE].reverse())).toBeCloseTo(16);
  });
});

describe('selfIntersectsClosed', () => {
  it('a simple square does not self-intersect', () => {
    expect(selfIntersectsClosed(SQUARE)).toBe(false);
  });
  it('a "bowtie" self-intersects', () => {
    const bowtie: Polyline = [
      { x: 0, y: 0 },
      { x: 4, y: 4 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ];
    expect(selfIntersectsClosed(bowtie)).toBe(true);
  });
});

describe('closedNormals', () => {
  it('has unit length at every vertex', () => {
    for (const nrm of closedNormals(SQUARE)) {
      expect(len(nrm)).toBeCloseTo(1);
    }
  });
});

describe('resampleClosed / chaikinClosed', () => {
  it('resampleClosed produces ~ perimeter/step vertices, all finite', () => {
    const out = resampleClosed(SQUARE, 0.5); // perimeter 16 / 0.5 = 32
    expect(out.length).toBe(32);
    expect(out.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
  it('chaikinClosed doubles the vertex count per iteration', () => {
    expect(chaikinClosed(SQUARE, 1).length).toBe(8);
    expect(chaikinClosed(SQUARE, 2).length).toBe(16);
  });
});
