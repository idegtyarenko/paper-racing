// Race/editor camera: the single affine world↔screen transform and the
// operations over it. Model: screen = world * scale + o, where scale is the
// cell size in css px, and (ox, oy) is the screen position of world point
// (0, 0). The grid is effectively infinite, so framing comes from this
// camera (fit-to-track), not from the world's size.

import { Vec, Polyline } from '../geometry';
import { SCALE_MIN, SCALE_MAX } from '../config';

export interface Camera {
  /** On-screen cell size, css px. */
  scale: number;
  /** Screen coordinates of world point (0, 0), css px. */
  ox: number;
  oy: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Viewport edges covered by opaque chrome, css px. The whole canvas is still
 * drawn — this only tells the framing which part of it the player can actually
 * see, so a track isn't fitted into space a side panel is sitting on.
 */
export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const NO_INSETS: Insets = { left: 0, right: 0, top: 0, bottom: 0 };

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

/** Bbox of a set of polylines in world coordinates (null polylines are skipped). */
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
 * Fit a bbox into the part of the viewport that chrome leaves free, along its
 * tighter axis, with a margin (as a fraction of that free area), and center it
 * there. Scale is clamped to [SCALE_MIN, SCALE_MAX]. With no insets the free
 * area is the whole viewport.
 */
export function fitBounds(
  bb: Bounds,
  viewW: number,
  viewH: number,
  marginFrac: number,
  insets: Insets = NO_INSETS,
): Camera {
  const bw = Math.max(1e-6, bb.maxX - bb.minX);
  const bh = Math.max(1e-6, bb.maxY - bb.minY);
  const freeW = Math.max(1, viewW - insets.left - insets.right);
  const freeH = Math.max(1, viewH - insets.top - insets.bottom);
  const availW = freeW * (1 - 2 * marginFrac);
  const availH = freeH * (1 - 2 * marginFrac);
  const scale = clampScale(Math.min(availW / bw, availH / bh));
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  return {
    scale,
    ox: insets.left + freeW / 2 - cx * scale,
    oy: insets.top + freeH / 2 - cy * scale,
  };
}

/**
 * Zoom relative to a screen point (sx, sy): the world point under it stays
 * put, and the scale is multiplied by factor (clamped). Returns a new camera.
 */
export function zoomAt(c: Camera, factor: number, sx: number, sy: number): Camera {
  const scale = clampScale(c.scale * factor);
  const k = scale / c.scale; // the actual multiplier after clamping
  return {
    scale,
    ox: sx - (sx - c.ox) * k,
    oy: sy - (sy - c.oy) * k,
  };
}

/**
 * Softly clamp panning: don't let the bounds' content fully drift out of the
 * area chrome leaves free — at least `keep` css px of its extent stays in
 * sight. Measured against the free area rather than the raw viewport, or the
 * track could be parked under a side panel and count as visible. Only
 * changes (ox, oy).
 */
export function clampToBounds(
  c: Camera,
  bb: Bounds,
  viewW: number,
  viewH: number,
  insets: Insets = NO_INSETS,
  keep = 48,
): Camera {
  const left = bb.minX * c.scale;
  const right = bb.maxX * c.scale;
  const top = bb.minY * c.scale;
  const bottom = bb.maxY * c.scale;
  // ox stays within [freeRight - right - keep, ...] — keeps the extent overlapping the free area.
  const oxMin = insets.left + keep - right;
  const oxMax = viewW - insets.right - keep - left;
  const oyMin = insets.top + keep - bottom;
  const oyMax = viewH - insets.bottom - keep - top;
  return {
    scale: c.scale,
    ox: clampRange(c.ox, oxMin, oxMax),
    oy: clampRange(c.oy, oyMin, oyMax),
  };
}

function clampRange(v: number, lo: number, hi: number): number {
  // For very small content, lo can exceed hi — in that case, center it.
  if (lo > hi) return (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, v));
}
