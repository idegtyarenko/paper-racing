// Камера гонки/редактора: единый аффинный переход мир↔экран и операции над ним.
// Модель: screen = world * scale + o, где scale — размер клетки в css-px,
// (ox, oy) — экранная позиция мировой точки (0, 0). Сетка условно бесконечна,
// поэтому кадр задаётся не размером мира, а этой камерой (fit-to-track).

import { Vec, Polyline } from './geometry';
import { SCALE_MIN, SCALE_MAX } from './config';

export interface Camera {
  /** Размер клетки на экране, css-px. */
  scale: number;
  /** Экранные координаты мировой точки (0, 0), css-px. */
  ox: number;
  oy: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const worldToScreen = (c: Camera, w: Vec): Vec => ({
  x: w.x * c.scale + c.ox,
  y: w.y * c.scale + c.oy,
});

export const screenToWorld = (c: Camera, s: Vec): Vec => ({
  x: (s.x - c.ox) / c.scale,
  y: (s.y - c.oy) / c.scale,
});

export const clampScale = (scale: number): number =>
  Math.max(SCALE_MIN, Math.min(SCALE_MAX, scale));

/** Bbox набора полилиний в мировых координатах (null-полилинии игнорируются). */
export function polylineBounds(...polys: (Polyline | null | undefined)[]): Bounds | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const poly of polys) {
    if (!poly) continue;
    for (const p of poly) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/**
 * Вписать bbox в вьюпорт по тесной оси с полем margin (доля вьюпорта) и
 * отцентрировать. Масштаб ограничен [SCALE_MIN, SCALE_MAX].
 */
export function fitBounds(
  bb: Bounds,
  viewW: number,
  viewH: number,
  marginFrac: number,
): Camera {
  const bw = Math.max(1e-6, bb.maxX - bb.minX);
  const bh = Math.max(1e-6, bb.maxY - bb.minY);
  const availW = viewW * (1 - 2 * marginFrac);
  const availH = viewH * (1 - 2 * marginFrac);
  const scale = clampScale(Math.min(availW / bw, availH / bh));
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  return {
    scale,
    ox: viewW / 2 - cx * scale,
    oy: viewH / 2 - cy * scale,
  };
}

/**
 * Зум относительно экранной точки (sx, sy): мировая точка под ней остаётся на
 * месте, масштаб умножается на factor (с клампом). Возвращает новую камеру.
 */
export function zoomAt(c: Camera, factor: number, sx: number, sy: number): Camera {
  const scale = clampScale(c.scale * factor);
  const k = scale / c.scale; // фактический множитель после клампа
  return {
    scale,
    ox: sx - (sx - c.ox) * k,
    oy: sy - (sy - c.oy) * k,
  };
}

/**
 * Мягко ограничить пан: не даём содержимому bounds полностью уехать из вьюпорта —
 * хотя бы `keep` css-px его габарита остаётся видимо. Меняет только (ox, oy).
 */
export function clampToBounds(
  c: Camera,
  bb: Bounds,
  viewW: number,
  viewH: number,
  keep = 48,
): Camera {
  const left = bb.minX * c.scale;
  const right = bb.maxX * c.scale;
  const top = bb.minY * c.scale;
  const bottom = bb.maxY * c.scale;
  // ox допустим в [viewW - right - keep? ...] — держим пересечение габарита с вьюпортом.
  const oxMin = keep - right;
  const oxMax = viewW - keep - left;
  const oyMin = keep - bottom;
  const oyMax = viewH - keep - top;
  return {
    scale: c.scale,
    ox: clampRange(c.ox, oxMin, oxMax),
    oy: clampRange(c.oy, oyMin, oyMax),
  };
}

function clampRange(v: number, lo: number, hi: number): number {
  // При очень малом содержимом lo может превысить hi — тогда центрируем.
  if (lo > hi) return (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, v));
}
