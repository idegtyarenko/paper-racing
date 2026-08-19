import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  Vec,
  Polyline,
  closedNormals,
  lerp,
  sub,
  dot,
  dist,
  normalize,
  pointInPolygon,
} from '../geometry';
import { WidthModel, autoFinishIndex, generateEdges, rebuildEdges } from './centerline';
import { processStroke } from './track';
import { strings } from '../i18n';
import {
  newEditor,
  pointerDown,
  pointerMove,
  pointerUp,
  confirmEdges,
  confirmFinish,
  confirmDirection,
  pointerCancel,
  clipPerpAt,
} from './editor';

/** A closed "stadium" centerline: two horizontal straights joined by semicircle
 *  ends. Straights sit at y = cy±R over x ∈ [cx−L/2, cx+L/2]; ends curve on the
 *  left/right. Used to check that the finish lands on a straight near its end. */
function stadium(cx = 60, cy = 60, L = 60, R = 15): Polyline {
  const pts: Vec[] = [];
  const step = 2;
  for (let x = cx - L / 2; x <= cx + L / 2; x += step) pts.push({ x, y: cy - R });
  for (let a = -Math.PI / 2; a <= Math.PI / 2; a += 0.15)
    pts.push({ x: cx + L / 2 + R * Math.cos(a), y: cy + R * Math.sin(a) });
  for (let x = cx + L / 2; x >= cx - L / 2; x -= step) pts.push({ x, y: cy + R });
  for (let a = Math.PI / 2; a <= (Math.PI * 3) / 2; a += 0.15)
    pts.push({ x: cx - L / 2 + R * Math.cos(a), y: cy + R * Math.sin(a) });
  return pts;
}

/** Uniform-width model over a centerline (for deterministic placement tests). */
function uniformModel(center: Polyline, halfW = 2): WidthModel {
  return {
    center,
    outNormal: closedNormals(center),
    outW: center.map(() => halfW),
    inW: center.map(() => halfW),
  };
}

/** Per-vertex turn angle (0 = straight) of a closed polyline. */
function turnAngles(c: Polyline): number[] {
  const n = c.length;
  return c.map((_, i) => {
    const prev = c[(i - 1 + n) % n];
    const next = c[(i + 1) % n];
    const din = { x: c[i].x - prev.x, y: c[i].y - prev.y };
    const dout = { x: next.x - c[i].x, y: next.y - c[i].y };
    const li = Math.hypot(din.x, din.y);
    const lo = Math.hypot(dout.x, dout.y);
    if (li < 1e-6 || lo < 1e-6) return 0;
    const crs = din.x * dout.y - din.y * dout.x;
    const dt = din.x * dout.x + din.y * dout.y;
    return Math.atan2(Math.abs(crs), dt);
  });
}

/** A big elliptical loop stroke to feed the editor's drawing step. */
function ellipseStroke(cx = 60, cy = 60, rx = 24, ry = 18): Vec[] {
  const pts: Vec[] = [];
  for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.12)
    pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  return pts;
}

/** Wobble a stroke the way a finger does — deterministic, no random. */
function noisy(stroke: Vec[], amp = 0.35): Vec[] {
  return stroke.map((p, i) => ({
    x: p.x + amp * Math.sin(i * 1.7),
    y: p.y + amp * Math.cos(i * 2.3),
  }));
}

/** Drive the editor through drawing a loop → adjust step. */
function drawLoop(stroke: Vec[]) {
  const st = newEditor();
  pointerDown(st, stroke[0]);
  for (const p of stroke.slice(1)) pointerMove(st, p);
  pointerUp(st);
  return st;
}

describe('autoFinishIndex', () => {
  it('places the finish on a straight, near its end (approaching a corner)', () => {
    const center = stadium();
    const m = uniformModel(center);
    const i = autoFinishIndex(m);
    const turn = turnAngles(center);
    const n = center.length;

    // On a straight: the chosen vertex itself barely turns.
    expect(turn[i]).toBeLessThan(0.05);
    // On one of the two straights (y ≈ cy ± R = 45 or 75), not on a curved end.
    const y = center[i].y;
    expect(Math.min(Math.abs(y - 45), Math.abs(y - 75))).toBeLessThan(1.5);
    // Near the end: a corner (high turn) comes up within a few vertices ahead.
    const cornerAhead = Array.from({ length: 8 }, (_, k) => turn[(i + 1 + k) % n]).some(
      (t) => t > 0.1,
    );
    expect(cornerAhead).toBe(true);
  });
});

describe('editor auto-placed finish + pre-selected direction', () => {
  it('auto-places the start/finish on arrival at the finish step', () => {
    const st = drawLoop(ellipseStroke());
    expect(st.step).toBe('adjust');
    confirmEdges(st);
    expect(st.step).toBe('finish');
    // Placed automatically — no drag needed.
    expect(st.finish).not.toBeNull();
  });

  it('pre-selects a direction when reaching the direction step', () => {
    const st = drawLoop(ellipseStroke());
    confirmEdges(st);
    confirmFinish(st);
    expect(st.step).toBe('direction');
    expect(st.arrows).not.toBeNull();
    // Direction is pre-selected (not null, as it was before).
    expect(st.forward).not.toBeNull();
    expect(st.forward).toEqual(st.arrows![0].forward);
  });

  it('tapping the other arrow flips direction without advancing', () => {
    const st = drawLoop(ellipseStroke());
    confirmEdges(st);
    confirmFinish(st);
    const other = st.arrows![1];
    pointerDown(st, lerp(other.from, other.tip, 0.5));
    // Flipped, still on the direction step (no auto-advance to ready).
    expect(st.step).toBe('direction');
    expect(st.forward).toEqual(other.forward);
  });

  it('confirmDirection advances to the transient ready state', () => {
    const st = drawLoop(ellipseStroke());
    confirmEdges(st);
    confirmFinish(st);
    confirmDirection(st);
    expect(st.step).toBe('ready');
    expect(st.forward).not.toBeNull();
  });
});

describe('direction arrows follow the road', () => {
  /** A tight circular loop: curvature strong enough that a straight arrow of the
   *  same length would leave the road. */
  function circleStroke(cx = 60, cy = 60, r = 12): Vec[] {
    const pts: Vec[] = [];
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.1)
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    return pts;
  }

  function atDirection(stroke: Vec[]) {
    const st = drawLoop(stroke);
    confirmEdges(st);
    confirmFinish(st);
    return st;
  }

  it('keeps both arrows on the road surface', () => {
    const st = atDirection(circleStroke());
    for (const arrow of st.arrows!) {
      for (const p of arrow.path) {
        expect(pointInPolygon(p, st.outer!)).toBe(true);
        expect(pointInPolygon(p, st.inner!)).toBe(false);
      }
    }
  });

  it('actually bends with the loop (a straight arrow would pass this fixture)', () => {
    // Guards the test above: on a straight arrow every point could still land on
    // the road by luck of the width roll, so demand a real turn along the path.
    const st = atDirection(circleStroke());
    for (const arrow of st.arrows!) {
      const head = normalize(sub(arrow.path[1], arrow.path[0]));
      const tail = normalize(
        sub(arrow.path[arrow.path.length - 1], arrow.path[arrow.path.length - 2]),
      );
      expect(Math.acos(Math.min(1, dot(head, tail)))).toBeGreaterThan(0.15);
    }
  });

  it('exposes from/tip as the ends of the path', () => {
    const st = atDirection(circleStroke());
    for (const arrow of st.arrows!) {
      expect(arrow.path.length).toBeGreaterThan(2);
      expect(arrow.path[0]).toEqual(arrow.from);
      expect(arrow.path[arrow.path.length - 1]).toEqual(arrow.tip);
    }
  });

  it('leaves the finish line and heads the way forward', () => {
    const st = atDirection(circleStroke());
    const mid = lerp(st.finish!.a, st.finish!.b, 0.5);
    for (const arrow of st.arrows!) {
      // Starts clear of the line, ends about four cells down the road.
      expect(dist(mid, arrow.from)).toBeGreaterThan(0.9);
      expect(dist(mid, arrow.from)).toBeLessThan(1.6);
      expect(dist(mid, arrow.tip)).toBeGreaterThan(2.5);
      const head = normalize(sub(arrow.path[1], arrow.path[0]));
      expect(dot(head, arrow.forward)).toBeGreaterThan(0.8);
    }
  });

  it('bends smoothly — no zigzag between path segments', () => {
    // A hand-drawn stroke is noisy; the arrow rides a smoothed mid-lane, so
    // consecutive segments must never kink.
    const st = atDirection(noisy(circleStroke()));
    for (const arrow of st.arrows!) {
      for (let i = 1; i < arrow.path.length - 1; i++) {
        const din = normalize(sub(arrow.path[i], arrow.path[i - 1]));
        const dout = normalize(sub(arrow.path[i + 1], arrow.path[i]));
        expect(Math.acos(Math.min(1, dot(din, dout)))).toBeLessThan(0.3);
      }
    }
  });

  it('tapping anywhere along the curved arrow flips direction', () => {
    const st = atDirection(circleStroke());
    const other = st.arrows![1];
    pointerDown(st, other.path[Math.floor(other.path.length / 2)]);
    expect(st.forward).toEqual(other.forward);
  });
});

describe('start/finish placement misses', () => {
  /** The editor sitting on the finish step with a line already placed. */
  function atFinish() {
    const st = drawLoop(ellipseStroke());
    confirmEdges(st);
    expect(st.finish).not.toBeNull();
    return st;
  }

  it('keeps the placed line when the tap lands off the track', () => {
    const st = atFinish();
    const placed = st.finish;
    // Far outside the loop.
    pointerDown(st, { x: 200, y: 200 });
    expect(st.finish).toBe(placed); // not even transiently dropped
    pointerUp(st);
    expect(st.finish).toBe(placed);
  });

  it('says why the tap did nothing', () => {
    const st = atFinish();
    pointerDown(st, { x: 200, y: 200 });
    pointerUp(st);
    expect(st.error).toBe(true);
    expect(st.message).toBe(strings.editor.errors.finishMiss);
  });

  it('still moves the line when the tap is on the road', () => {
    const st = atFinish();
    const placed = st.finish;
    pointerDown(st, st.center![10]);
    pointerUp(st);
    expect(st.finish).not.toBe(placed);
    expect(st.error).toBe(false);
  });

  it('keeps the line through a cancelled gesture', () => {
    const st = atFinish();
    const placed = st.finish;
    pointerDown(st, st.center![10]);
    pointerCancel(st);
    expect(st.finish).not.toBeNull();
    expect(st.error).toBe(true);
    // The preview may have moved it, but there is still a line on the track.
    expect(st.finish === placed || st.finish !== null).toBe(true);
  });
});

// The start/finish line must go ACROSS the road. Taking the normal of the nearest
// centerline vertex isn't enough: where the road doubles back on itself the nearest
// vertex belongs to the neighbouring stretch, and its normal points along the road
// rather than across it — the line then ran for tens of cells down the tarmac
// instead of the three or four it takes to span it.
describe('finish line goes across the road, not along it', () => {
  /** Deterministic Math.random, so the random width profile doesn't make this flaky. */
  function seedRandom(seed: number): void {
    let a = seed;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A hand-drawn-looking loop: a circle with a few harmonics on the radius. The
   *  wobble is what folds the road back on itself; `seed`/`amp` below are a shape
   *  the generator accepts and that used to produce lines 8x too long. */
  function wobblyStroke(seed: number, amp: number): Vec[] {
    let a = seed;
    const rnd = (): number => {
      a = (a * 1103515245 + 12345) & 0x7fffffff;
      return a / 0x7fffffff;
    };
    const harmonics = Array.from({ length: 5 }, () => ({
      a: rnd() * amp,
      ph: rnd() * 6.28,
    }));
    const pts: Vec[] = [];
    for (let i = 0; i <= 240; i++) {
      const t = (Math.PI * 2 * i) / 240;
      let r = 30;
      harmonics.forEach((h, n) => (r += h.a * Math.cos((n + 2) * t + h.ph)));
      pts.push({ x: 60 + r * Math.cos(t), y: 60 + r * Math.sin(t) });
    }
    return pts;
  }

  /** The wobbly track, run through the real pipeline the editor uses. */
  function wobblyTrack() {
    seedRandom(3);
    const ps = processStroke(wobblyStroke(3, 8));
    if ('error' in ps) throw new Error(`stroke rejected: ${ps.error}`);
    const gen = generateEdges(ps.poly);
    if ('error' in gen) throw new Error(`edges rejected: ${gen.error}`);
    return gen;
  }

  /** Length of the line itself: clipFinishLine pushes the ends 0.25 past each wall. */
  function span(finish: { a: Vec; b: Vec }): number {
    return dist(finish.a, finish.b) - 0.5;
  }

  it('never runs much longer than the road is wide, anywhere on the track', () => {
    const { model, outer, inner } = wobblyTrack();
    for (let i = 0; i < model.center.length; i++) {
      const width = model.outW[i] + model.inW[i];
      const n = model.outNormal[i];
      for (const f of [-0.45, -0.25, 0, 0.25, 0.45]) {
        const p = {
          x: model.center[i].x + n.x * f * width,
          y: model.center[i].y + n.y * f * width,
        };
        const res = clipPerpAt(model, p, outer, inner);
        if ('error' in res) continue;
        // Some slack: the walls aren't parallel, so a crossing can legitimately
        // outrun the nominal width a little on a bend.
        expect(span(res.finish)).toBeLessThan(1.4 * width);
      }
    }
  });

  it('crosses the road where the neighbouring stretch used to hijack the direction', () => {
    const { model, outer, inner } = wobblyTrack();
    const p = { x: 47.4, y: 55.4 };
    const res = clipPerpAt(model, p, outer, inner);
    if ('error' in res) throw new Error('no line at the sample point');
    expect(span(res.finish)).toBeLessThan(5);
  });

  it('still crosses square on a plain bend, not tilted toward the apex', () => {
    const center = stadium();
    const m = uniformModel(center);
    // A vertex in the middle of a curved end.
    const i = center.findIndex((p) => p.x > 100 && Math.abs(p.y - 60) < 2);
    expect(i).toBeGreaterThan(-1);
    const { outer, inner } = rebuildEdges(m);
    const res = clipPerpAt(m, center[i], outer, inner);
    if ('error' in res) throw new Error('no line on the bend');
    const dir = normalize(sub(res.finish.b, res.finish.a));
    // Within a few degrees of the centerline normal.
    expect(Math.abs(dot(dir, m.outNormal[i]))).toBeGreaterThan(Math.cos(0.1));
  });
});

describe('editor errors vs. step hints', () => {
  it('flags a cancelled gesture as an error (toast), not a step hint', () => {
    const st = drawLoop(ellipseStroke());
    confirmEdges(st);
    pointerDown(st, { x: 60, y: 60 });
    pointerCancel(st);
    expect(st.error).toBe(true);
    expect(st.message).toBe(strings.editor.gestureCancelled);
  });

  it('clears the error on the next gesture in every step, so it can re-toast', () => {
    const st = drawLoop(ellipseStroke());
    expect(st.step).toBe('adjust');
    pointerCancel(st);
    pointerDown(st, { x: 60, y: 60 });
    expect(st.error).toBe(false);
    expect(st.message).toBe(strings.editor.step.adjust);
  });
});
