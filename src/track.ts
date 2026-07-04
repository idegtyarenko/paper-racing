// Модель трассы: обработка нарисованных штрихов, валидация, финализация.

import {
  Vec,
  Polyline,
  add,
  sub,
  dot,
  dist,
  lerp,
  scale,
  normalize,
  pointInPolygon,
  distPointToPolyline,
  distPointToSegment,
  segmentPolylineIntersections,
  resampleClosed,
  chaikinClosed,
  trimSeamOverlap,
} from './geometry';

// Размеры мира в клетках. Изменяемы: подбираются под пропорции доски при
// первом resize (см. main.ts) и фиксируются, как только начата трасса.
export let WORLD_W = 64;
export let WORLD_H = 40;

export function setWorldSize(w: number, h: number): void {
  WORLD_W = w;
  WORLD_H = h;
}

/** Зазор до стенки: узлы ближе к краю не считаются частью дороги. */
const WALL_CLEARANCE = 0.15;

export interface FinishLine {
  a: Vec;
  b: Vec;
}

export interface Track {
  outer: Polyline;
  inner: Polyline;
  finish: FinishLine;
  /** Единичная нормаль финишной линии в направлении гонки. */
  forward: Vec;
  /** Узлы сетки, лежащие на дороге (ключи — см. key()). */
  inside: Set<number>;
  /** Стартовые узлы, строго позади финишной линии (ближайшие к ней — первыми). */
  startPoints: Vec[];
}

/** Максимум стартовых позиций, которые готовит трасса (по числу игроков). */
const MAX_START_POINTS = 6;

const KEY_OFFSET = 128;

export const key = (x: number, y: number): number =>
  (x + KEY_OFFSET) * 4096 + (y + KEY_OFFSET);

export const unkey = (k: number): Vec => ({
  x: Math.floor(k / 4096) - KEY_OFFSET,
  y: (k % 4096) - KEY_OFFSET,
});

export type StrokeResult = { poly: Polyline } | { error: string };

/** Замыкание, ресемплинг и сглаживание сырого freehand-штриха. */
export function processStroke(raw: Vec[]): StrokeResult {
  if (raw.length < 8) {
    return { error: 'Слишком короткий росчерк — обведи контур целиком, одним движением.' };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of raw) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (diag < 4) {
    return { error: 'Мелковато для трассы — черкни размашистее.' };
  }
  if (dist(raw[0], raw[raw.length - 1]) > 0.25 * diag) {
    return { error: 'Круг не замкнулся — доведи линию обратно к началу росчерка.' };
  }
  const maxTrim = Math.max(2, 0.12 * diag); // порог «мелкого» нахлёста концов
  const closed = trimSeamOverlap(raw, maxTrim);
  let poly = resampleClosed(closed, 0.5);
  poly = chaikinClosed(poly, 2);
  poly = resampleClosed(poly, 0.5);
  return { poly };
}

/** Точка (не обязательно узел) лежит на дороге между краями. */
export function onRoad(p: Vec, outer: Polyline, inner: Polyline): boolean {
  return pointInPolygon(p, outer) && !pointInPolygon(p, inner);
}

function isRoadLatticePoint(p: Vec, outer: Polyline, inner: Polyline): boolean {
  return (
    onRoad(p, outer, inner) &&
    distPointToPolyline(p, outer) > WALL_CLEARANCE &&
    distPointToPolyline(p, inner) > WALL_CLEARANCE
  );
}

/**
 * Строит финишную линию по протяжке пользователя: линия продлевается в обе
 * стороны, из пересечений с краями берётся участок дороги, содержащий
 * середину протяжки. Концы выносятся на 0.25 клетки за стенки, чтобы закрыть
 * численные щели. Протяжку не обязательно вести точно от стенки до стенки —
 * достаточно задать направление поперёк дороги.
 */
export type ClipFinishResult =
  | { finish: FinishLine }
  | { error: 'no-cross' | 'narrow' };

export function clipFinishLine(
  a: Vec,
  b: Vec,
  outer: Polyline,
  inner: Polyline,
): ClipFinishResult {
  const d = normalize(sub(b, a));
  if (d.x === 0 && d.y === 0) return { error: 'no-cross' };
  const EXT = 200;
  const A = sub(a, scale(d, EXT));
  const B = add(b, scale(d, EXT));
  const hits = [
    ...segmentPolylineIntersections(A, B, outer),
    ...segmentPolylineIntersections(A, B, inner),
  ].sort((x, y) => x.t - y.t);
  const mid = lerp(a, b, 0.5);
  const tMid = dot(sub(mid, A), d) / dist(A, B);
  for (let i = 0; i + 1 < hits.length; i++) {
    if (hits[i].t <= tMid && tMid <= hits[i + 1].t) {
      const p1 = hits[i].point;
      const p2 = hits[i + 1].point;
      // Середина отрезка между соседними пересечениями вне дороги —
      // линия проходит по «пробелу» (мимо дороги), а не поперёк неё.
      if (!onRoad(lerp(p1, p2, 0.5), outer, inner)) return { error: 'no-cross' };
      // Дорога пересечена правильно, но слишком узка в этом месте.
      if (dist(p1, p2) < 1) return { error: 'narrow' };
      return { finish: { a: sub(p1, scale(d, 0.25)), b: add(p2, scale(d, 0.25)) } };
    }
  }
  return { error: 'no-cross' };
}

/** Знаковое расстояние точки до финишной линии вдоль направления гонки. */
export function sideOfFinish(track: Pick<Track, 'finish' | 'forward'>, p: Vec): number {
  return dot(sub(p, track.finish.a), track.forward);
}

export type FinalizeResult = { track: Track } | { error: string };

export function finalizeTrack(
  outer: Polyline,
  inner: Polyline,
  finish: FinishLine,
  forward: Vec,
): FinalizeResult {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outer) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const x0 = Math.max(0, Math.floor(minX));
  const x1 = Math.min(WORLD_W, Math.ceil(maxX));
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(WORLD_H, Math.ceil(maxY));

  const inside = new Set<number>();
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (isRoadLatticePoint({ x, y }, outer, inner)) inside.add(key(x, y));
    }
  }
  if (inside.size < 30) {
    return {
      error:
        'Полотно слишком узкое — болидам не разъехаться. ' +
        'Раздвинь бортики пошире.',
    };
  }

  const behind: Vec[] = [];
  inside.forEach((k) => {
    const p = unkey(k);
    if (sideOfFinish({ finish, forward }, p) < -1e-9) behind.push(p);
  });
  behind.sort((p, q) => {
    const dp = distPointToSegment(p, finish.a, finish.b);
    const dq = distPointToSegment(q, finish.a, finish.b);
    return dp - dq || p.y - q.y || p.x - q.x;
  });
  if (behind.length < 2) {
    return { error: 'За стартовой чертой негде выстроить болиды — сдвинь линию.' };
  }
  return {
    track: {
      outer,
      inner,
      finish,
      forward,
      inside,
      startPoints: behind.slice(0, MAX_START_POINTS),
    },
  };
}
