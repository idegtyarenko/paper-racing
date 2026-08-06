import { describe, it, expect } from 'vitest';
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
import { WidthModel, autoFinishIndex } from './centerline';
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
