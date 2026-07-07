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

// CCW-квадрат 4×4 (стандартная ориентация, y вверх): signedArea > 0.
const SQUARE: Polyline = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 4, y: 4 },
  { x: 0, y: 4 },
];

describe('segSegIntersection', () => {
  it('находит точку чистого пересечения и параметр t вдоль первого отрезка', () => {
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

  it('параллельные непересекающиеся (не на одной прямой) → null', () => {
    expect(
      segSegIntersection({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 1 }, { x: 4, y: 1 }),
    ).toBeNull();
  });

  it('коллинеарное перекрытие → начало общей части', () => {
    const hit = segSegIntersection(
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 2, y: 0 },
      { x: 6, y: 0 },
    );
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(2);
  });

  it('касание концами считается пересечением', () => {
    const hit = segSegIntersection(
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
    );
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(1);
  });

  it('вырожденный первый отрезок → null', () => {
    expect(
      segSegIntersection({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 0 }, { x: 2, y: 2 }),
    ).toBeNull();
  });
});

describe('pointOnSegment', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 4, y: 0 };
  it('внутренняя точка и концы — на отрезке', () => {
    expect(pointOnSegment({ x: 2, y: 0 }, a, b)).toBe(true);
    expect(pointOnSegment(a, a, b)).toBe(true);
    expect(pointOnSegment(b, a, b)).toBe(true);
  });
  it('коллинеарная, но за пределами — не на отрезке', () => {
    expect(pointOnSegment({ x: 5, y: 0 }, a, b)).toBe(false);
    expect(pointOnSegment({ x: -1, y: 0 }, a, b)).toBe(false);
  });
  it('вне прямой — не на отрезке', () => {
    expect(pointOnSegment({ x: 2, y: 1 }, a, b)).toBe(false);
  });
});

describe('closestPointOnSegment / distPointToSegment', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 4, y: 0 };
  it('перпендикуляр в середину', () => {
    const c = closestPointOnSegment({ x: 2, y: 5 }, a, b);
    expect(c.x).toBeCloseTo(2);
    expect(c.y).toBeCloseTo(0);
    expect(distPointToSegment({ x: 2, y: 5 }, a, b)).toBeCloseTo(5);
  });
  it('зажимает на концах', () => {
    expect(closestPointOnSegment({ x: -3, y: 1 }, a, b)).toEqual({ x: 0, y: 0 });
    expect(closestPointOnSegment({ x: 9, y: 1 }, a, b)).toEqual({ x: 4, y: 0 });
  });
});

describe('pointInPolygon', () => {
  it('внутри / снаружи квадрата', () => {
    expect(pointInPolygon({ x: 2, y: 2 }, SQUARE)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 5 }, SQUARE)).toBe(false);
    expect(pointInPolygon({ x: -1, y: 2 }, SQUARE)).toBe(false);
  });
});

describe('distPointToPolyline', () => {
  it('расстояние до ближайшего ребра', () => {
    expect(distPointToPolyline({ x: 2, y: 2 }, SQUARE)).toBeCloseTo(2);
    expect(distPointToPolyline({ x: 2, y: 6 }, SQUARE)).toBeCloseTo(2);
  });
});

describe('signedArea / polygonArea', () => {
  it('знак кодирует направление обхода (CCW > 0)', () => {
    expect(signedArea(SQUARE)).toBeGreaterThan(0);
    expect(signedArea([...SQUARE].reverse())).toBeLessThan(0);
  });
  it('polygonArea — модуль знаковой площади', () => {
    expect(polygonArea(SQUARE)).toBeCloseTo(16);
    expect(polygonArea([...SQUARE].reverse())).toBeCloseTo(16);
  });
});

describe('selfIntersectsClosed', () => {
  it('простой квадрат не самопересекается', () => {
    expect(selfIntersectsClosed(SQUARE)).toBe(false);
  });
  it('«восьмёрка» самопересекается', () => {
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
  it('единичной длины во всех вершинах', () => {
    for (const nrm of closedNormals(SQUARE)) {
      expect(len(nrm)).toBeCloseTo(1);
    }
  });
});

describe('resampleClosed / chaikinClosed', () => {
  it('resampleClosed выдаёт ~ периметр/шаг вершин, все конечные', () => {
    const out = resampleClosed(SQUARE, 0.5); // периметр 16 / 0.5 = 32
    expect(out.length).toBe(32);
    expect(out.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
  it('chaikinClosed удваивает число вершин за итерацию', () => {
    expect(chaikinClosed(SQUARE, 1).length).toBe(8);
    expect(chaikinClosed(SQUARE, 2).length).toBe(16);
  });
});
