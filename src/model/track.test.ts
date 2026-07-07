import { describe, it, expect } from 'vitest';
import { Polyline } from '../geometry';
import { strings } from '../strings';
import {
  onRoad,
  sideOfFinish,
  processStroke,
  clipFinishLine,
  finalizeTrack,
} from './track';
import { OUTER, INNER, FINISH, FORWARD, ringTrack } from './test-fixtures';
import { MIN_ROAD_CELLS } from '../config';

describe('onRoad', () => {
  it('точка в рамке — на дороге; в дыре и снаружи — нет', () => {
    expect(onRoad({ x: 10, y: 4 }, OUTER, INNER)).toBe(true);
    expect(onRoad({ x: 20, y: 12 }, OUTER, INNER)).toBe(false); // внутри inner
    expect(onRoad({ x: 50, y: 50 }, OUTER, INNER)).toBe(false); // за outer
  });
});

describe('sideOfFinish', () => {
  it('знак совпадает с направлением гонки (forward = +x, финиш у x=6)', () => {
    const t = { finish: FINISH, forward: FORWARD };
    expect(sideOfFinish(t, { x: 10, y: 4 })).toBeGreaterThan(0);
    expect(sideOfFinish(t, { x: 2, y: 4 })).toBeLessThan(0);
  });
});

describe('processStroke', () => {
  it('меньше 8 точек → ошибка «штрих короткий»', () => {
    const res = processStroke([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 0 },
      { x: 3, y: 1 },
      { x: 2, y: 2 },
    ]);
    expect(res).toEqual({ error: strings.track.strokeShort });
  });

  it('крошечный штрих (диагональ < 4) → ошибка «штрих короткий»', () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({
      x: Math.cos(i) * 0.5,
      y: Math.sin(i) * 0.5,
    }));
    expect(processStroke(raw)).toEqual({ error: strings.track.strokeShort });
  });

  it('незамкнутый штрих (концы далеко) → ошибка «не замкнуто»', () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({ x: i * 2, y: 0 }));
    expect(processStroke(raw)).toEqual({ error: strings.track.notClosed });
  });

  it('валидная замкнутая петля → сглаженная полилиния', () => {
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
  it('протяжка поперёк дороги → финишная линия, вынесенная за стенки', () => {
    // Протяжка в нижней прямой (x=20, где есть внутренняя стенка inner на y=8).
    const res = clipFinishLine({ x: 20, y: -1 }, { x: 20, y: 3 }, OUTER, INNER);
    expect('finish' in res).toBe(true);
    if ('finish' in res) {
      // Нижняя прямая: outer y=0, inner y=8 → концы ≈ (20,-0.25) и (20,8.25).
      expect(res.finish.a.y).toBeCloseTo(-0.25);
      expect(res.finish.b.y).toBeCloseTo(8.25);
    }
  });

  it('протяжка мимо дороги (по дыре) → no-cross', () => {
    const res = clipFinishLine({ x: 20, y: 12 }, { x: 20, y: 13 }, OUTER, INNER);
    expect(res).toEqual({ error: 'no-cross' });
  });

  it('протяжка поперёк слишком узкой дороги → narrow', () => {
    // Узкая перемычка сверху: зазор outer(y=10) − inner(y=9.5) = 0.5 < 1.
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
  it('валидное кольцо → трасса с дорогой и стартами', () => {
    const res = finalizeTrack(OUTER, INNER, FINISH, FORWARD);
    expect('track' in res).toBe(true);
    if ('track' in res) {
      expect(res.track.inside.size).toBeGreaterThanOrEqual(MIN_ROAD_CELLS);
      expect(res.track.startPoints.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('старты упорядочены от ближних к финишу', () => {
    const t = ringTrack();
    const d = (p: { x: number; y: number }) => Math.abs(p.x - 6); // расстояние до линии x=6
    for (let i = 1; i < t.startPoints.length; i++) {
      expect(d(t.startPoints[i])).toBeGreaterThanOrEqual(d(t.startPoints[i - 1]) - 1e-9);
    }
  });

  it('слишком тесное кольцо → ошибка', () => {
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
