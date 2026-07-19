import { describe, it, expect } from 'vitest';
import { Vec, Polyline } from '../geometry';
import { strings } from '../i18n';
import {
  onRoad,
  sideOfFinish,
  processStroke,
  clipFinishLine,
  finalizeTrack,
  layoutStartGrid,
} from './track';
import { OUTER, INNER, FINISH, FORWARD, ringTrack } from './test-fixtures';
import { MIN_ROAD_CELLS, MAX_START_POINTS, START_ROW_MAX } from '../config';

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

  it('старты упорядочены от ближних к финишу (поул — index 0)', () => {
    const t = ringTrack();
    const d = (p: Vec) => Math.abs(p.x - 6); // расстояние до линии x=6
    for (let i = 1; i < t.startPoints.length; i++) {
      expect(d(t.startPoints[i])).toBeGreaterThanOrEqual(d(t.startPoints[i - 1]) - 1e-9);
    }
  });

  it('старты — центрированная решётка: минимум рядов, не по краям', () => {
    // Нижняя прямая: дорога y≈1..7, центр y=4. Старты жмутся к центру (не сбоку) и
    // укладываются в минимум рядов: 6 болидов = 2 ряда по 3 (глубина всего 1 клетка).
    const t = ringTrack();
    expect(t.startPoints.length).toBe(MAX_START_POINTS);
    for (const p of t.startPoints) {
      expect(Math.abs(p.y - 4)).toBeLessThanOrEqual(1); // близко к центру, не у стенок
    }
    expect(new Set(t.startPoints.map((p) => p.y)).size).toBeLessThanOrEqual(
      START_ROW_MAX,
    );
    // Глубина: не больше ceil(6/3)=2 рядов (в фикстуре ряды различаются по x).
    expect(new Set(t.startPoints.map((p) => p.x)).size).toBeLessThanOrEqual(2);
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

describe('layoutStartGrid', () => {
  // Финиш поперёк (a=(6,0),b=(6,8)), гонка в +x: для точки back = 6−x, lat = y−4.
  const finish = { a: { x: 6, y: 0 }, b: { x: 6, y: 8 } };
  const forward: Vec = { x: 1, y: 0 };
  const backOf = (p: Vec) => 6 - p.x;

  it('широкая зона → центрированная решётка ≤ MAX, спереди назад', () => {
    const behind: Vec[] = [];
    for (let x = 1; x <= 5; x++) for (let y = 1; y <= 7; y++) behind.push({ x, y });
    const grid = layoutStartGrid(finish, forward, behind);
    expect(grid.length).toBe(MAX_START_POINTS);
    // Упорядочены по возрастанию отступа назад.
    for (let i = 1; i < grid.length; i++) {
      expect(backOf(grid[i])).toBeGreaterThanOrEqual(backOf(grid[i - 1]) - 1e-9);
    }
    // Жмутся к центру (y=4), не к краям; ряд шириной до START_ROW_MAX.
    for (const p of grid) expect(Math.abs(p.y - 4)).toBeLessThanOrEqual(1);
    expect(new Set(grid.map((p) => p.y)).size).toBeLessThanOrEqual(START_ROW_MAX);
    // Минимум глубины: 6 болидов = 2 ряда (по x), не больше.
    expect(new Set(grid.map((p) => backOf(p))).size).toBeLessThanOrEqual(2);
    // Первый ряд заполнен до START_ROW_MAX на самой линии — малые составы (2–3
    // болида берут передние слоты) стартуют без глубины.
    const front = grid.slice(0, START_ROW_MAX).map(backOf);
    expect(new Set(front).size).toBe(1);
    // Без повторов клеток.
    expect(new Set(grid.map((p) => `${p.x},${p.y}`)).size).toBe(grid.length);
  });

  it('одна колонка узлов → паровозиком, все рассажены', () => {
    // Единственный поперечный ряд y=4 (узкий старт): решётка вырождается в
    // одну линию, но всех кандидатов всё равно рассаживает по глубине.
    const behind: Vec[] = [1, 2, 3, 4, 5].map((x) => ({ x, y: 4 }));
    const grid = layoutStartGrid(finish, forward, behind);
    expect(grid.length).toBe(5);
    expect(grid.every((p) => p.y === 4)).toBe(true);
    expect(grid.map((p) => p.x)).toEqual([5, 4, 3, 2, 1]); // спереди (ближе к линии) назад
  });

  it('всего две клетки → обе становятся стартами', () => {
    const behind: Vec[] = [
      { x: 5, y: 4 },
      { x: 4, y: 4 },
    ];
    expect(layoutStartGrid(finish, forward, behind)).toHaveLength(2);
  });
});
