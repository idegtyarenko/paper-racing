// Чистые геометрические примитивы. Все координаты — в клетках (world space).
// Замкнутые полилинии хранятся без дублирования первой точки: ребро
// последняя→первая подразумевается.

export interface Vec {
  x: number;
  y: number;
}

export type Polyline = Vec[];

const EPS = 1e-9;

export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export function normalize(a: Vec): Vec {
  const l = len(a);
  return l < EPS ? { x: 0, y: 0 } : scale(a, 1 / l);
}

/** Тест «точка внутри полигона» методом чёт/нечет (ray casting). */
export function pointInPolygon(p: Vec, poly: Polyline): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y) {
      const xCross = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (p.x < xCross) inside = !inside;
    }
  }
  return inside;
}

export interface SegHit {
  /** Параметр вдоль первого отрезка p1→p2, 0..1. */
  t: number;
  point: Vec;
}

/**
 * Пересечение отрезков p1→p2 и q1→q2. Касание считается пересечением.
 * Для коллинеарного перекрытия возвращается начало общей части.
 */
export function segSegIntersection(p1: Vec, p2: Vec, q1: Vec, q2: Vec): SegHit | null {
  const r = sub(p2, p1);
  const s = sub(q2, q1);
  const denom = cross(r, s);
  const qp = sub(q1, p1);
  if (Math.abs(denom) < EPS) {
    if (Math.abs(cross(qp, r)) > EPS) return null; // параллельны, не на одной прямой
    const rr = dot(r, r);
    if (rr < EPS) return null; // вырожденный первый отрезок
    let t0 = dot(qp, r) / rr;
    let t1 = dot(sub(q2, p1), r) / rr;
    if (t0 > t1) [t0, t1] = [t1, t0];
    const lo = Math.max(t0, 0);
    const hi = Math.min(t1, 1);
    if (lo > hi + EPS) return null;
    return { t: lo, point: lerp(p1, p2, lo) };
  }
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  const tc = Math.min(1, Math.max(0, t));
  return { t: tc, point: lerp(p1, p2, tc) };
}

export function distPointToSegment(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const ab2 = dot(ab, ab);
  const t = ab2 < EPS ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), ab) / ab2));
  return dist(p, lerp(a, b, t));
}

export function distPointToPolyline(p: Vec, poly: Polyline): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    d = Math.min(d, distPointToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  }
  return d;
}

/** Все пересечения отрезка a→b с рёбрами замкнутой полилинии, по возрастанию t. */
export function segmentPolylineIntersections(a: Vec, b: Vec, poly: Polyline): SegHit[] {
  const hits: SegHit[] = [];
  for (let i = 0; i < poly.length; i++) {
    const hit = segSegIntersection(a, b, poly[i], poly[(i + 1) % poly.length]);
    if (hit) hits.push(hit);
  }
  hits.sort((x, y) => x.t - y.t);
  return hits;
}

/** Перераспределяет вершины замкнутой полилинии равномерно с заданным шагом. */
export function resampleClosed(poly: Polyline, spacing: number): Polyline {
  const n = poly.length;
  if (n < 3) return poly.slice();
  const cum: number[] = [0];
  for (let i = 0; i < n; i++) {
    cum.push(cum[i] + dist(poly[i], poly[(i + 1) % n]));
  }
  const total = cum[n];
  if (total < spacing * 4) return poly.slice();
  const count = Math.max(12, Math.round(total / spacing));
  const step = total / count;
  const out: Vec[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (seg < n - 1 && cum[seg + 1] < target) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    const t = segLen < EPS ? 0 : (target - cum[seg]) / segLen;
    out.push(lerp(poly[seg], poly[(seg + 1) % n], t));
  }
  return out;
}

/** Сглаживание Чайкина для замкнутой полилинии (срезание углов). */
export function chaikinClosed(poly: Polyline, iterations: number): Polyline {
  let pts = poly;
  for (let it = 0; it < iterations; it++) {
    const out: Vec[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      out.push(lerp(a, b, 0.25), lerp(a, b, 0.75));
    }
    pts = out;
  }
  return pts;
}

/** Проверка самопересечения замкнутой полилинии (несмежные рёбра). */
export function selfIntersectsClosed(poly: Polyline): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a1 = poly[i];
    const a2 = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // смежны через замыкание
      if (segSegIntersection(a1, a2, poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

export function polygonArea(poly: Polyline): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    s += cross(poly[i], poly[(i + 1) % poly.length]);
  }
  return Math.abs(s) / 2;
}
