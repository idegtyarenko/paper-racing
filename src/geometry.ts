// Pure geometric primitives. All coordinates are in cells (world space).
// Closed polylines are stored without duplicating the first point: the
// last→first edge is implied.

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

/** "Point inside polygon" test via the even-odd rule (ray casting). */
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
  /** Parameter along the first segment p1→p2, 0..1. */
  t: number;
  point: Vec;
}

/**
 * Intersection of segments p1→p2 and q1→q2. A touch counts as an
 * intersection. For collinear overlap, returns the start of the shared part.
 */
export function segSegIntersection(p1: Vec, p2: Vec, q1: Vec, q2: Vec): SegHit | null {
  const r = sub(p2, p1);
  const s = sub(q2, q1);
  const denom = cross(r, s);
  const qp = sub(q1, p1);
  if (Math.abs(denom) < EPS) {
    if (Math.abs(cross(qp, r)) > EPS) return null; // parallel, not collinear
    const rr = dot(r, r);
    if (rr < EPS) return null; // degenerate first segment
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

/** Whether point p lies on segment a→b (endpoints included, with EPS
 *  tolerance). */
export function pointOnSegment(p: Vec, a: Vec, b: Vec): boolean {
  const ab = sub(b, a);
  const ap = sub(p, a);
  // A zero-length segment is a single point — only a itself lies on it. Without
  // this guard cross, proj and dot(ab,ab) all collapse to 0 and the checks below
  // pass for *any* p (the "stay put" move being blocked by every car on the track).
  if (dot(ab, ab) <= EPS) return dot(ap, ap) <= EPS;
  if (Math.abs(cross(ab, ap)) > EPS) return false; // not collinear with line a→b
  const proj = dot(ap, ab);
  return proj >= -EPS && proj <= dot(ab, ab) + EPS;
}

/** Closest point to p on segment a→b. */
export function closestPointOnSegment(p: Vec, a: Vec, b: Vec): Vec {
  const ab = sub(b, a);
  const ab2 = dot(ab, ab);
  const t = ab2 < EPS ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), ab) / ab2));
  return lerp(a, b, t);
}

export function distPointToSegment(p: Vec, a: Vec, b: Vec): number {
  return dist(p, closestPointOnSegment(p, a, b));
}

export function distPointToPolyline(p: Vec, poly: Polyline): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    d = Math.min(d, distPointToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  }
  return d;
}

/** All intersections of segment a→b with the edges of a closed polyline,
 *  sorted by increasing t. */
export function segmentPolylineIntersections(a: Vec, b: Vec, poly: Polyline): SegHit[] {
  const hits: SegHit[] = [];
  for (let i = 0; i < poly.length; i++) {
    const hit = segSegIntersection(a, b, poly[i], poly[(i + 1) % poly.length]);
    if (hit) hits.push(hit);
  }
  hits.sort((x, y) => x.t - y.t);
  return hits;
}

/** Redistributes a closed polyline's vertices evenly at a given spacing. */
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

/** Chaikin smoothing for a closed polyline (corner-cutting). */
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

/**
 * Trims a self-overlap at the seam of an open stroke. Looks for an
 * intersection between an early segment (the head) and a later one (the
 * tail); if the total length of the discarded ends doesn't exceed maxTrim,
 * it cuts the overlap, returning the contour [X, raw[i+1..j]], where X is
 * the intersection point. Otherwise returns the original stroke unchanged.
 *
 * A small threshold rules out mid-loop self-intersections (which would
 * discard a large arc) and leaves those for the validator to reject — this
 * only fixes a small overlap at the ends of the ring.
 */
export function trimSeamOverlap(raw: Vec[], maxTrim: number): Vec[] {
  const n = raw.length;
  if (n < 4) return raw;
  const cum: number[] = [0];
  for (let i = 0; i < n - 1; i++) cum.push(cum[i] + dist(raw[i], raw[i + 1]));
  const total = cum[n - 1];

  let best: { i: number; j: number; point: Vec } | null = null;
  let bestTrim = maxTrim;
  for (let i = 0; i < n - 1; i++) {
    if (cum[i] >= bestTrim) break; // head already longer than the best so far — no point continuing
    for (let j = i + 2; j < n - 1; j++) {
      const trim = cum[i] + (total - cum[j + 1]);
      if (trim >= bestTrim) continue;
      const hit = segSegIntersection(raw[i], raw[i + 1], raw[j], raw[j + 1]);
      if (hit) {
        best = { i, j, point: hit.point };
        bestTrim = trim;
      }
    }
  }
  if (!best) return raw;
  return [best.point, ...raw.slice(best.i + 1, best.j + 1)];
}

/**
 * Laplacian smoothing for a closed polyline: each vertex is pulled toward the
 * midpoint of its neighbors by a fraction `factor`. The vertex count is
 * preserved (unlike Chaikin) — important wherever vertex indices need to
 * stay stable.
 */
export function smoothClosed(poly: Polyline, iterations: number, factor = 0.5): Polyline {
  let pts = poly;
  for (let it = 0; it < iterations; it++) {
    const n = pts.length;
    const out: Vec[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n];
      const b = pts[i];
      const c = pts[(i + 1) % n];
      out[i] = {
        x: b.x + ((a.x + c.x) / 2 - b.x) * factor,
        y: b.y + ((a.y + c.y) / 2 - b.y) * factor,
      };
    }
    pts = out;
  }
  return pts;
}

/** Checks whether a closed polyline self-intersects (non-adjacent edges). */
export function selfIntersectsClosed(poly: Polyline): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a1 = poly[i];
    const a2 = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent via the closing edge
      if (segSegIntersection(a1, a2, poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** Signed area of a closed polyline (>0 means counter-clockwise winding). */
export function signedArea(poly: Polyline): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    s += cross(poly[i], poly[(i + 1) % poly.length]);
  }
  return s / 2;
}

export function polygonArea(poly: Polyline): number {
  return Math.abs(signedArea(poly));
}

/**
 * Unit normals at each vertex of a closed polyline, pointing outward (away
 * from the shape's center). Each normal is built from the averaged tangent
 * of the adjacent edges.
 */
export function closedNormals(poly: Polyline): Vec[] {
  const n = poly.length;
  // The winding direction determines which way the tangent's "left" normal points.
  const outward = signedArea(poly) > 0 ? -1 : 1;
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const next = poly[(i + 1) % n];
    const t = normalize(sub(next, prev));
    // Rotate the tangent by 90°, sign determined by outward direction.
    out.push({ x: -t.y * outward, y: t.x * outward });
  }
  return out;
}
