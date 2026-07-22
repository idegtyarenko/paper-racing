// Viewport: mutable camera state and framing policy layered on top of the
// pure camera.ts. Knows HOW to fit/clamp/move the camera given content
// bounds; WHAT is currently on screen (the bounds) is supplied by the caller
// via boundsProvider. The only DOM it touches is the canvas/wrapper (size +
// rect) — no rendering happens here. Exactly one viewport per app instance
// (module-level singleton).

import { Vec } from '../geometry';
import { WORLD_SIZE, SCALE_DEFAULT, FIT_MARGIN } from '../config';
import {
  Camera,
  Bounds,
  screenToWorld,
  fitBounds,
  zoomAt as camZoomAt,
  clampToBounds,
} from './camera';

let canvas: HTMLCanvasElement;
let wrap: Element;
/** Bounds of the current content in world coordinates (or null for an empty field). */
let boundsProvider: () => Bounds | null = () => null;

/** Camera: the single world↔screen transform. Initialized in resize() before the first frame. */
let cam: Camera = { scale: SCALE_DEFAULT, ox: 0, oy: 0 };
/** User manually zoomed/panned: on resize we preserve their view instead of
 *  re-fitting the track. Reset on every auto-fit. */
let userAdjustedView = false;

export function initViewport(
  canvasEl: HTMLCanvasElement,
  wrapEl: Element,
  bounds: () => Bounds | null,
): void {
  canvas = canvasEl;
  wrap = wrapEl;
  boundsProvider = bounds;
}

/** Current camera (for redraw()/render and worldToScreen). */
export function camera(): Camera {
  return cam;
}

/** On-screen cell size, css px (for touchTol()/loupeActive()). */
export function scale(): number {
  return cam.scale;
}

export function viewSize(): { w: number; h: number } {
  const r = wrap.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

/** Starting view for an empty field: the world's center in the viewport's center. */
function defaultCamera(w: number, h: number): Camera {
  const c = WORLD_SIZE / 2;
  return {
    scale: SCALE_DEFAULT,
    ox: w / 2 - c * SCALE_DEFAULT,
    oy: h / 2 - c * SCALE_DEFAULT,
  };
}

/** Fit the content centered (or the default view, if there's no content). */
export function fitToContent(): void {
  const { w, h } = viewSize();
  const bb = boundsProvider();
  cam = bb ? fitBounds(bb, w, h, FIT_MARGIN) : defaultCamera(w, h);
  userAdjustedView = false;
}

/** Clamp panning so the track never fully drifts out of view. */
export function clamp(): void {
  const bb = boundsProvider();
  if (!bb) return;
  const { w, h } = viewSize();
  cam = clampToBounds(cam, bb, w, h);
}

export function toScreen(e: PointerEvent): Vec {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

export function toWorld(e: PointerEvent, liftPx = 0): Vec {
  const p = toScreen(e);
  const w = screenToWorld(cam, { x: p.x, y: p.y - liftPx });
  // Clamp to the bounds of the (square) world — it's safely large enough
  // that at the default scale it feels infinite while drawing.
  return {
    x: Math.max(0, Math.min(WORLD_SIZE, w.x)),
    y: Math.max(0, Math.min(WORLD_SIZE, w.y)),
  };
}

/** Recompute the canvas size and framing for the current viewport size (no redraw). */
export function resize(): void {
  const r = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  canvas.style.width = `${r.width}px`;
  canvas.style.height = `${r.height}px`;
  // Framing follows the content: an empty field gets the default view; a
  // track gets fit centered. If the user has manually zoomed/panned, we keep
  // their scale and just re-clamp the offset for the new size.
  const bb = boundsProvider();
  if (!bb) cam = defaultCamera(r.width, r.height);
  else if (userAdjustedView) cam = clampToBounds(cam, bb, r.width, r.height);
  else cam = fitBounds(bb, r.width, r.height, FIT_MARGIN);
}

/** Zoom relative to a screen point: mark the view as user-adjusted + clamp it. */
export function zoomAt(factor: number, sx: number, sy: number): void {
  cam = camZoomAt(cam, factor, sx, sy);
  userAdjustedView = true;
  clamp();
}

/** Apply a user-driven camera (pinch/pan): set + mark adjusted + clamp. */
export function applyUserCamera(next: Camera): void {
  cam = next;
  userAdjustedView = true;
  clamp();
}
