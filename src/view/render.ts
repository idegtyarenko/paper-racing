// Rendering for both phases on a single canvas: a full redraw on every event.

import { Vec, Polyline, add, sub, scale, normalize, lerp } from '../geometry';
import { Track } from '../model/track';
import { EditorState, Arrow } from '../model/editor';
import { GameState, Candidate, Drive, TrailSeg } from '../model/game';
import { aeroFactor, forwardCap } from '../model/turns';
import { Camera } from './camera';
import { computeLanes, LaneStop } from './trail-lanes';

export interface AppView {
  mode: 'edit' | 'race';
  editor: EditorState;
  game: GameState | null;
  cands: Candidate[] | null;
  hover: Candidate | null;
  /** Candidate picked by touch, awaiting a confirming tap. */
  selected: Candidate | null;
  /** Pending pick: a move pre-selected for our seat while it's someone else's
   *  turn (online/vs bots), waiting for a manual "Go!". Drawn in a distinct
   *  style (dashed ring). */
  pending: Candidate | null;
  /** Seat that owns the candidate fan: on our turn it's game.current; on the
   *  opponent's turn while pre-picking, it's our own seat. −1 means no fan. */
  candSeat: number;
  /** Finger position in canvas css pixels — drives the "loupe" while aiming. */
  loupe: Vec | null;
  /** Camera: the single world↔screen transform (scale + offset). */
  cam: Camera;
}

// Canvas render palette — the "blueprint" direction: dark blue field, cyan
// grid, road surface highlighted ON TOP of the background (see the "Paper
// Racing — Canvas System" design). BG/EDGE/ACCENT used to mirror the DOM
// tokens in base.css (--paper/--ink/--accent). This redesign phase only
// touches the canvas; the DOM still stays cream-colored, so these values are
// DELIBERATELY out of sync with base.css — the next phase (DOM) will
// reconcile them.
/** Field background (dark blue "blueprint"); also the loupe fill and the base for trail blending. */
const BG = '#0d3252';
/** Track edge and editor sketch lines — a solid cyan line over the background. */
const EDGE = '#7fd3ff';
/** Grid over the bare background — barely-there cool cyan (heavier every 5 cells). */
const GRID_LIGHT = 'rgba(127, 211, 255, 0.05)';
const GRID_HEAVY = 'rgba(127, 211, 255, 0.10)';
/** Same grid, brightened under the road surface (clipped to the track ring). */
const GRID_ROAD_LIGHT = 'rgba(127, 211, 255, 0.15)';
const GRID_ROAD_HEAVY = 'rgba(127, 211, 255, 0.24)';
/** Light cyan wash highlighting the road surface. */
const ROAD_WASH = 'rgba(127, 211, 255, 0.05)';
/** Amber accent: the direction arrow and drag handles in the editor. */
const ACCENT = '#ffb454';
/** Halo behind the car and crash mark — background color, reads as contrast over the trail. */
const HALO = '#0d3252';
/** Muted blue-gray: jump segments of the trail and blocked candidates. */
const MUTED = '#a7bdd0';
/** Cyan loupe ring. */
const LOUPE_RING = '#7fd3ff';
/** Centerline hint during edge tuning (draggable). */
const CENTERLINE_HINT = 'rgba(127, 211, 255, 0.5)';
/** Crash candidate cross (red). */
const CRASH = '#ff5d5d';
/** Cells, shadow, and border of the finish line's checkered flag (dark cell = background color). */
const FLAG_DARK = '#0d3252';
const FLAG_LIGHT = '#bfe6ff';
const FLAG_SHADOW = 'rgba(0,0,0,0.1)';
const FLAG_BORDER = 'rgba(127, 211, 255, 0.45)';

// Trail thickness, luminance, and glow all grow with move speed (segment
// length): fast straights get a heavy, hot, glowing line, slow crawling
// through corners a thin, dim one.
//
// On paper the trail mixed PAPER→color (0.14..1), so slow moves RECEDED INTO
// THE FIELD and fast ones hit full strength — the readable channel was
// contrast against the background, with a huge dynamic range. On navy that
// same trick goes muddy: background-mixing pulls red toward a brown-gray.
// The dark-field equivalent is to recede by dropping LUMINANCE while keeping
// saturation — RGB scaled toward black proportionally stays unmistakably the
// car's hue (r >> g,b for red) but sits low-contrast against the navy, just
// like the pale stroke did on paper. So the ramp runs
//   dark (dim) → pure car color (at TRAIL_MID) → hot, near-white
// which restores the old dynamic range without ever touching the background.
// Never globalAlpha: it left dark spots at segment joints.
const TRAIL_SPEED_REF = 6;
const TRAIL_WIDTH_MIN = 1.0;
const TRAIL_WIDTH_MAX = 4.0;
/** Luminance multiplier at zero speed. Not lower: cool cars (blue, teal) sit
 *  closer to the navy field than warm ones and would vanish entirely. */
const TRAIL_DIM_MIN = 0.5;
/** Lightening toward white at max speed. */
const TRAIL_LIGHTEN_MAX = 0.5;
/** Speed factor at which the trail is the pure, unmodified car color. */
const TRAIL_MID = 0.55;
/** Glow radius (css px) at max speed — the blueprint "backlit line" idiom,
 *  and the channel that reads fastest in peripheral vision. */
const TRAIL_GLOW_MAX = 7;
/** Cap on the miter at sharp corners, in multiples of the lane offset. */
const TRAIL_MITER_MAX = 2.5;

/** `#rrggbb` → rgb triple. */
function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Car color moved along the speed ramp: `t` < 0 darkens toward black (scaling
 * the channels, which preserves hue and saturation — unlike mixing into the
 * background, which grays it out), `t` > 0 lightens toward white.
 */
function shade(hex: string, t: number): string {
  const [r, g, b] = rgbOf(hex);
  const f = t < 0 ? (c: number) => c * (1 + t) : (c: number) => c + (255 - c) * t;
  return `rgb(${Math.round(f(r))}, ${Math.round(f(g))}, ${Math.round(f(b))})`;
}

/**
 * `shade` amount for the pre-pick preview (waiting for someone else to move):
 * the whole preview loses luminance while keeping its hue, so "your turn" and
 * "planning ahead" never look alike. It must NOT be done with `globalAlpha` —
 * fading into the navy field turns red marks brown-gray, the same mistake the
 * trail ramp made before d9f0ae0. Same contrast floor as TRAIL_DIM_MIN: don't
 * go past ≈−0.5, or cool marks sink into the background.
 */
const PRESELECT_DIM = -0.45;

// Geometry for race markers. Radii scale with `s` (px per cell); line widths
// are constant px, matching the design. Values are taken from the "Canvas
// System" design (primary source) and "Design Exploration" (for states not
// covered by CS); the design draws on a 26px grid, so `size_px / 26` gives
// the fraction of `s`. Collected here so they can all be tuned in one place.
/** Move candidate: dashed cyan ring (normal / inertial). */
const CAND_R = 0.27;
const CAND_R_INERTIAL = 0.34;
const CAND_R_MIN = 4;
const CAND_DASH: [number, number] = [3, 4];
const CAND_LW = 1.9;
const CAND_ALPHA = 1;
/** Hovered/selected candidate: solid ring + center dot. */
const CAND_HOVER_LW = 2;
const CAND_HOVER_DOT_R = 0.12;
/** Blocked node: gray cross. */
const BLOCK_R = 0.23;
const BLOCK_R_MIN = 3.5;
const BLOCK_LW = 1.8;
/** Crash candidate (move into a wall): solid red ring. Held just under full
 *  strength so it reads as a warning rather than the loudest mark on screen —
 *  an available move is the thing the eye should land on first. */
const CRASH_CAND_LW = 2;
const CRASH_CAND_ALPHA = 0.85;
/** Traction zone fill under the candidate points. */
const DRIVE_AREA_ALPHA = 0.1;
/** Aim line from the car to the hovered candidate. */
const AIM_LINE_ALPHA = 0.35;
/** Pending pick (queued for a later turn): the selection ring, one step quieter. */
const PENDING_LW = 2;
const PENDING_DASH: [number, number] = [4, 3];
const PENDING_RING_ALPHA = 0.55;
const PENDING_LINE_ALPHA = 0.4;
const PENDING_R_PAD = 3;
/** Crash mark on the trail: halo background + red cross. */
const CRASH_MARK_R = 0.27;
const CRASH_MARK_R_MIN = 4;
const CRASH_HALO_LW = 4.5;
const CRASH_STROKE_LW = 2.2;
/** Car outline (halo background over the trail). */
const CAR_STROKE_LW = 2;

export function render(ctx: CanvasRenderingContext2D, app: AppView): void {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = ctx.canvas.width / dpr;
  const h = ctx.canvas.height / dpr;
  const s = app.cam.scale;

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  // The scene is drawn under the camera transform (zoom/pan); the loupe is drawn on top, in screen coordinates.
  ctx.save();
  ctx.translate(app.cam.ox, app.cam.oy);
  drawGrid(ctx, s, app.cam.ox, app.cam.oy, 0, 0, w, h, GRID_LIGHT, GRID_HEAVY);
  if (app.mode === 'edit') {
    drawEditor(ctx, s, app.editor);
  } else if (app.game) {
    drawRace(
      ctx,
      s,
      app.game,
      app.cands,
      app.hover ?? app.selected,
      app.pending,
      app.candSeat,
    );
  }
  ctx.restore();

  if (app.mode !== 'edit' && app.game && app.loupe) drawLoupe(ctx, app, w, h);
}

/**
 * "Loupe" for touch aiming: a zoomed-in fragment of the scene around the
 * touch point, offset above the finger so the finger doesn't cover it.
 */
function drawLoupe(
  ctx: CanvasRenderingContext2D,
  app: AppView,
  w: number,
  h: number,
): void {
  const R = 64;
  const ZOOM = 3;
  const p = app.loupe!;
  const cx = Math.min(Math.max(p.x, R + 4), Math.max(R + 4, w - R - 4));
  const cy = Math.max(p.y - R - 36, R + 4);
  const s2 = app.cam.scale * ZOOM;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = BG;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  // World point under the finger (accounting for the camera) — placed at the loupe's center.
  const wx = (p.x - app.cam.ox) / app.cam.scale;
  const wy = (p.y - app.cam.oy) / app.cam.scale;
  const ox2 = cx - wx * s2;
  const oy2 = cy - wy * s2;
  ctx.translate(ox2, oy2);
  drawGrid(ctx, s2, ox2, oy2, cx - R, cy - R, cx + R, cy + R, GRID_LIGHT, GRID_HEAVY);
  drawRace(
    ctx,
    s2,
    app.game!,
    app.cands,
    app.hover ?? app.selected,
    app.pending,
    app.candSeat,
  );
  ctx.restore();

  ctx.strokeStyle = LOUPE_RING;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
}

/**
 * Infinite grid: only draw lines that fall inside the visible window
 * [vx0..vx1] × [vy0..vy1] (screen css px). ctx is already translated by
 * (ox, oy), so world node n is drawn at coordinate n*s. A heavier line every
 * 5 cells (works correctly for negative coordinates too).
 */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  s: number,
  ox: number,
  oy: number,
  vx0: number,
  vy0: number,
  vx1: number,
  vy1: number,
  light: string,
  heavy: string,
): void {
  const x0 = Math.floor((vx0 - ox) / s);
  const x1 = Math.ceil((vx1 - ox) / s);
  const y0 = Math.floor((vy0 - oy) / s);
  const y1 = Math.ceil((vy1 - oy) / s);
  const top = y0 * s;
  const bottom = y1 * s;
  const left = x0 * s;
  const right = x1 * s;
  ctx.lineWidth = 1;
  for (let x = x0; x <= x1; x++) {
    ctx.strokeStyle = ((x % 5) + 5) % 5 === 0 ? heavy : light;
    ctx.beginPath();
    ctx.moveTo(x * s, top);
    ctx.lineTo(x * s, bottom);
    ctx.stroke();
  }
  for (let y = y0; y <= y1; y++) {
    ctx.strokeStyle = ((y % 5) + 5) % 5 === 0 ? heavy : light;
    ctx.beginPath();
    ctx.moveTo(left, y * s);
    ctx.lineTo(right, y * s);
    ctx.stroke();
  }
}

function strokePoly(
  ctx: CanvasRenderingContext2D,
  s: number,
  poly: Polyline,
  close: boolean,
): void {
  if (poly.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(poly[0].x * s, poly[0].y * s);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * s, poly[i].y * s);
  if (close) ctx.closePath();
  ctx.stroke();
}

/** Add a closed polyline contour to the current path (without filling/stroking). */
function addPolyPath(ctx: CanvasRenderingContext2D, s: number, poly: Polyline): void {
  if (poly.length < 2) return;
  ctx.moveTo(poly[0].x * s, poly[0].y * s);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * s, poly[i].y * s);
  ctx.closePath();
}

/**
 * "Blueprint" track surface: the road is drawn ON TOP of the background
 * rather than cut out of it. The off-track area stays the bare dark
 * background (already filled in render). The surface is the ring between
 * outer and inner (without inner, it's the whole interior of outer): a light
 * cyan wash + grid brightened under the ring clip, plus a solid cyan edge.
 */
function drawRoadSurface(
  ctx: CanvasRenderingContext2D,
  s: number,
  outer: Polyline | null,
  inner: Polyline | null,
): void {
  if (!outer) return;
  // Surface path: the outer/inner ring (even-odd); without inner, the whole interior of outer.
  const ringPath = (): void => {
    ctx.beginPath();
    addPolyPath(ctx, s, outer);
    if (inner) addPolyPath(ctx, s, inner);
  };

  // 1) Light cyan wash over the surface.
  ctx.save();
  ctx.fillStyle = ROAD_WASH;
  ringPath();
  ctx.fill('evenodd');
  ctx.restore();

  // 2) Brightened grid under the surface — clipped to the ring, over the pale
  //    background grid. ctx is already translated by (cam.ox, cam.oy) in
  //    render; grid lines sit at worldNode*s regardless of that translation,
  //    so here we pass ox/oy=0 and a window in those same translated
  //    coordinates (the outer edge's bbox, padded by one cell). The clip
  //    trims off the rest.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of outer) {
    const px = p.x * s;
    const py = p.y * s;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  ctx.save();
  ringPath();
  ctx.clip('evenodd');
  drawGrid(
    ctx,
    s,
    0,
    0,
    minX - s,
    minY - s,
    maxX + s,
    maxY + s,
    GRID_ROAD_LIGHT,
    GRID_ROAD_HEAVY,
  );
  ctx.restore();

  // 3) Solid cyan edge along both boundaries of the surface.
  ctx.save();
  ctx.strokeStyle = EDGE;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  addPolyPath(ctx, s, outer);
  if (inner) addPolyPath(ctx, s, inner);
  ctx.stroke();
  ctx.restore();
}

function drawTrackEdges(
  ctx: CanvasRenderingContext2D,
  s: number,
  outer: Polyline | null,
  inner: Polyline | null,
): void {
  ctx.strokeStyle = EDGE;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (outer) strokePoly(ctx, s, outer, true);
  if (inner) strokePoly(ctx, s, inner, true);
}

function drawFinishLine(ctx: CanvasRenderingContext2D, s: number, a: Vec, b: Vec): void {
  const d = sub(b, a);
  const len = Math.hypot(d.x, d.y);
  if (len < 1e-9) return;
  const dir = { x: d.x / len, y: d.y / len };
  const n = { x: -dir.y, y: dir.x };

  const lenPx = len * s;
  const rows = 2;
  const cell = Math.max(2.5, s * 0.2);
  const bandHalf = (rows * cell) / 2;
  // Inset slightly from the track edges so the rectangular band doesn't
  // stick out past the curved edge right at points a/b.
  const inset = Math.min(lenPx * 0.15, bandHalf);
  const usableLen = Math.max(cell, lenPx - inset * 2);
  const ax = a.x * s + dir.x * inset;
  const ay = a.y * s + dir.y * inset;
  const cols = Math.max(1, Math.round(usableLen / cell));
  const actualCell = usableLen / cols;

  ctx.save();
  // Light shadow under the flag for a bit of depth.
  ctx.save();
  ctx.translate(0.5, 0.7);
  ctx.fillStyle = FLAG_SHADOW;
  for (let i = 0; i < cols; i++) {
    for (let r = 0; r < rows; r++) {
      if ((i + r) % 2 !== 0) continue;
      const cx =
        ax + dir.x * (i + 0.5) * actualCell + n.x * (-bandHalf + (r + 0.5) * cell);
      const cy =
        ay + dir.y * (i + 0.5) * actualCell + n.y * (-bandHalf + (r + 0.5) * cell);
      drawCheckerCell(ctx, cx, cy, dir, n, actualCell, cell);
    }
  }
  ctx.restore();

  for (let i = 0; i < cols; i++) {
    for (let r = 0; r < rows; r++) {
      const dark = (i + r) % 2 === 0;
      ctx.fillStyle = dark ? FLAG_DARK : FLAG_LIGHT;
      const cx =
        ax + dir.x * (i + 0.5) * actualCell + n.x * (-bandHalf + (r + 0.5) * cell);
      const cy =
        ay + dir.y * (i + 0.5) * actualCell + n.y * (-bandHalf + (r + 0.5) * cell);
      drawCheckerCell(ctx, cx, cy, dir, n, actualCell, cell);
    }
  }

  // Thin border around the band's perimeter for a clean edge.
  ctx.strokeStyle = FLAG_BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const bx = ax + dir.x * usableLen;
  const by = ay + dir.y * usableLen;
  const p1 = { x: ax + n.x * -bandHalf, y: ay + n.y * -bandHalf };
  const p2 = { x: bx + n.x * -bandHalf, y: by + n.y * -bandHalf };
  const p3 = { x: bx + n.x * bandHalf, y: by + n.y * bandHalf };
  const p4 = { x: ax + n.x * bandHalf, y: ay + n.y * bandHalf };
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.moveTo(p3.x, p3.y);
  ctx.lineTo(p4.x, p4.y);
  ctx.stroke();

  ctx.restore();
}

function drawCheckerCell(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  dir: Vec,
  n: Vec,
  cellAlongDir: number,
  cellAlongN: number,
): void {
  const hd = cellAlongDir / 2;
  const hn = cellAlongN / 2;
  const p1 = { x: cx - dir.x * hd - n.x * hn, y: cy - dir.y * hd - n.y * hn };
  const p2 = { x: cx + dir.x * hd - n.x * hn, y: cy + dir.y * hd - n.y * hn };
  const p3 = { x: cx + dir.x * hd + n.x * hn, y: cy + dir.y * hd + n.y * hn };
  const p4 = { x: cx - dir.x * hd + n.x * hn, y: cy - dir.y * hd + n.y * hn };
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(p3.x, p3.y);
  ctx.lineTo(p4.x, p4.y);
  ctx.closePath();
  ctx.fill();
}

/**
 * Arrow along a path: the shaft follows every vertex (so it can bend with the
 * road), the head sits at the last one, aimed down the closing segment. A
 * straight arrow is just a two-point path.
 */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  s: number,
  path: Polyline,
  color: string,
  width: number,
): void {
  const tip = path[path.length - 1];
  const d = normalize(sub(tip, path[path.length - 2]));
  const n = { x: -d.y, y: d.x };
  const headBase = sub(tip, scale(d, 0.5));
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(path[0].x * s, path[0].y * s);
  for (const p of path.slice(1, -1)) ctx.lineTo(p.x * s, p.y * s);
  ctx.lineTo(headBase.x * s, headBase.y * s);
  ctx.stroke();
  const l = add(headBase, scale(n, 0.24));
  const r = sub(headBase, scale(n, 0.24));
  ctx.beginPath();
  ctx.moveTo(tip.x * s, tip.y * s);
  ctx.lineTo(l.x * s, l.y * s);
  ctx.lineTo(r.x * s, r.y * s);
  ctx.closePath();
  ctx.fill();
}

function drawEditor(ctx: CanvasRenderingContext2D, s: number, ed: EditorState): void {
  // During edge tuning, show a faint centerline as a hint that edges are draggable.
  if (ed.step === 'adjust' && ed.center) {
    ctx.save();
    ctx.strokeStyle = CENTERLINE_HINT;
    ctx.lineWidth = 1;
    ctx.setLineDash([s * 0.25, s * 0.25]);
    strokePoly(ctx, s, ed.center, true);
    ctx.restore();
  }

  // From the "adjust" step onward, the edges are already closed — show the
  // same visualization as during the race: the road surface fill with its edge.
  // During "center" (drawing the centerline) there's no surface yet — draw a plain outline.
  if (ed.step !== 'center' && ed.outer && ed.inner) {
    drawRoadSurface(ctx, s, ed.outer, ed.inner);
  } else {
    drawTrackEdges(ctx, s, ed.outer, ed.inner);
  }

  // Actively dragged edge point — a square handle (design 3B): board-navy fill,
  // amber outline (not a solid amber dot).
  if (ed.step === 'adjust' && ed.dragEdge && ed.dragIndex !== null) {
    const edge = ed.dragEdge === 'outer' ? ed.outer : ed.inner;
    const pt = edge?.[ed.dragIndex];
    if (pt) {
      const half = Math.max(5, s * 0.28);
      const x = pt.x * s - half;
      const y = pt.y * s - half;
      const side = half * 2;
      ctx.save();
      ctx.fillStyle = BG;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, side, side, 2);
      else ctx.rect(x, y, side, side);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  if (ed.drawing && ed.stroke.length > 1) {
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.75;
    strokePoly(ctx, s, ed.stroke, false);
    ctx.globalAlpha = 1;
  }

  // Draw-head marker (design 3A): amber ring + dot at the live pen point. On
  // touch there's no OS cursor, so this is what shows under the finger; on
  // desktop it reinforces the ring+dot CSS cursor.
  if (ed.drawing && ed.stroke.length > 0) {
    const head = ed.stroke[ed.stroke.length - 1];
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.fillStyle = ACCENT;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(head.x * s, head.y * s, Math.max(9, s * 0.55), 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(head.x * s, head.y * s, Math.max(2.5, s * 0.16), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (ed.finish) drawFinishLine(ctx, s, ed.finish.a, ed.finish.b);

  // Touch point during the finish-line step — where the perpendicular mark is "pinned".
  if (ed.step === 'finish' && ed.dragStart) {
    ctx.save();
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.arc(
      ed.dragStart.x * s,
      ed.dragStart.y * s,
      Math.max(4, s * 0.22),
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.restore();
  }

  if (ed.step === 'direction' && ed.arrows) {
    // Direction is pre-selected: the chosen way is drawn loud (amber, thick),
    // the other quiet (cyan, thin) so it reads as "tap to flip", not "unset".
    for (const arrow of ed.arrows) {
      const chosen =
        !!ed.forward &&
        arrow.forward.x === ed.forward.x &&
        arrow.forward.y === ed.forward.y;
      if (chosen) drawArrow(ctx, s, arrow.path, ACCENT, 3);
      else drawArrow(ctx, s, arrow.path, EDGE, 1.8);
    }
  }

  if (ed.step === 'ready' && ed.arrows && ed.forward) {
    const chosen = ed.arrows.find(
      (a: Arrow) => a.forward.x === ed.forward!.x && a.forward.y === ed.forward!.y,
    );
    if (chosen) drawArrow(ctx, s, chosen.path, ACCENT, 2.5);
  }
}

/**
 * Fill for the "traction ellipse" — the zone around the coast point
 * C = pos + vel that contains the candidate points. In velocity-relative
 * coordinates: the front is a half-ellipse with semi-axes
 * (forwardCap(accel) × grip_eff), the back is (brake_eff × grip_eff); at the
 * start (vel = 0) it's a circle of radius forwardCap(accel). Braking and grip
 * account for downforce at the current speed (grip_eff/brake_eff =
 * grip/brake · aeroFactor), so the fill matches the actually reachable nodes. Drawn as a pale fill with no
 * stroke — marks the boundary with minimal visual noise.
 */
function drawDriveArea(
  ctx: CanvasRenderingContext2D,
  s: number,
  pos: Vec,
  vel: Vec,
  drive: Drive,
  color: string,
  alpha: number,
): void {
  const { accel, brake, grip, downforce } = drive;
  const speed = Math.hypot(vel.x, vel.y);
  const aero = aeroFactor(downforce, speed);
  const brakeEff = brake * aero;
  const gripEff = grip * aero;
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  if (speed === 0) {
    ctx.arc(pos.x * s, pos.y * s, forwardCap(accel) * s, 0, Math.PI * 2);
  } else {
    const cx = (pos.x + vel.x) * s;
    const cy = (pos.y + vel.y) * s;
    const phi = Math.atan2(vel.y, vel.x); // longitudinal axis = direction of travel
    // Two ellipse half-arcs meeting along the lateral axis (angles ±π/2): the
    // front uses semi-axis forwardCap(accel) along the direction of travel, the
    // back uses brake_eff; both use grip_eff sideways.
    ctx.ellipse(
      cx,
      cy,
      forwardCap(accel) * s,
      gripEff * s,
      phi,
      -Math.PI / 2,
      Math.PI / 2,
    );
    ctx.ellipse(cx, cy, brakeEff * s, gripEff * s, phi, Math.PI / 2, (3 * Math.PI) / 2);
    ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
}

function drawRace(
  ctx: CanvasRenderingContext2D,
  s: number,
  game: GameState,
  cands: Candidate[] | null,
  hover: Candidate | null,
  pending: Candidate | null,
  candSeat: number,
): void {
  drawTrackDecor(ctx, s, game.track);
  // Lanes need every trail at once (they depend on who overlaps whom), so they
  // are solved for the whole field before any of it is drawn.
  const lanes = computeLanes(game.players.map((p) => p.trail));
  game.players.forEach((p, i) =>
    drawTrail(ctx, s, p.trail, p.crashes, p.color, lanes[i]),
  );
  drawCars(ctx, s, game);
  drawCandidates(ctx, s, game, cands, hover, pending, candSeat);
}

/** Static track decoration: road surface, finish line, and direction arrow. */
function drawTrackDecor(ctx: CanvasRenderingContext2D, s: number, track: Track): void {
  drawRoadSurface(ctx, s, track.outer, track.inner);
  drawFinishLine(ctx, s, track.finish.a, track.finish.b);

  // Race direction arrow at the finish line.
  const m = lerp(track.finish.a, track.finish.b, 0.5);
  drawArrow(
    ctx,
    s,
    [add(m, scale(track.forward, 0.8)), add(m, scale(track.forward, 2.0))],
    ACCENT,
    2.4,
  );
}

/**
 * One player's trail plus crash marks. Trail brightness and thickness grow
 * with move speed, and BOTH have to change smoothly along the track rather
 * than stepping at each move boundary.
 *
 * The factor at a node is the average of the speeds of its adjacent segments
 * (when a neighbor exists, isn't a "jump", and shares this node with the
 * segment), otherwise it's just the segment's own speed. Color then comes
 * from a linear gradient between the two endpoint factors.
 *
 * Thickness can't be done with `stroke`: `lineWidth` is constant per stroke,
 * so the line visibly jumped at every node. Instead each segment is FILLED as
 * a tapered ribbon — a quad whose half-width at each end is that node's
 * width. Neighbouring segments share the node factor, so they meet at exactly
 * the same width and the taper is continuous across the whole trail. A disc
 * at each node fills the notch on the outside of a corner and rounds the
 * trail's ends (what `lineCap`/`lineJoin: round` used to do).
 *
 * Where this trail shares a line with another car it slides sideways into its
 * own "lane" so the two don't paint over each other; `lanes` carries that
 * offset (in cells) as stops along each segment, and a segment is subdivided
 * at those stops. Cars, crash marks, and candidates stay on the true nodes.
 *
 * Takes the trail apart from the player it belongs to, because the replay and
 * the post-move tween draw a PREFIX of a trail (plus a half-driven last
 * segment) rather than a player's current one; `alpha` is how the replay pushes
 * the finished race into the background while the cars re-drive it.
 */
export function drawTrail(
  ctx: CanvasRenderingContext2D,
  s: number,
  trail: TrailSeg[],
  crashes: Vec[],
  color: string,
  lanes: LaneStop[][],
  alpha = 1,
): void {
  // Move speed normalized to 0..1 by segment length (exponent >1 stretches
  // the slow↔fast gap).
  const segFactor = (i: number): number => {
    const seg = trail[i];
    const speed = Math.hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y);
    return Math.pow(Math.min(1, speed / TRAIL_SPEED_REF), 1.5);
  };
  // Index of the segment continuing the trail at this endpoint, if it exists,
  // isn't a jump, and actually touches this node — otherwise null (the node is
  // a free end, and both the taper and the lane offset fall back to this
  // segment alone).
  const neighbor = (i: number, end: 'from' | 'to'): number | null => {
    const j = end === 'from' ? i - 1 : i + 1;
    const nb = trail[j];
    if (!nb || nb.jump) return null;
    const node = trail[i][end];
    const shared = end === 'from' ? nb.to : nb.from;
    return shared.x === node.x && shared.y === node.y ? j : null;
  };
  // Factor at one endpoint of segment `i`, averaged with the adjacent segment.
  const nodeFactor = (i: number, end: 'from' | 'to'): number => {
    const own = segFactor(i);
    const j = neighbor(i, end);
    return j === null ? own : (own + segFactor(j)) / 2;
  };
  /** Unit left-normal of segment `i`, or null when it has no direction. */
  const segNormal = (i: number): Vec | null => {
    const seg = trail[i];
    const dx = seg.to.x - seg.from.x;
    const dy = seg.to.y - seg.from.y;
    const len = Math.hypot(dx, dy);
    return len === 0 ? null : { x: -dy / len, y: dx / len };
  };
  /**
   * Sideways shift (px) of one endpoint by `off` px. At a corner the two
   * adjacent segments want different normals; offsetting along their bisector —
   * lengthened by the miter factor 1/cos — keeps the lane a true parallel of
   * the path, so the ribbon stays connected instead of opening a gap on the
   * outside of the turn.
   */
  const nodeShift = (i: number, end: 'from' | 'to', off: number): Vec => {
    if (off === 0) return { x: 0, y: 0 };
    const own = segNormal(i);
    const j = neighbor(i, end);
    const nb = j === null ? null : segNormal(j);
    if (!own) return nb ? scale(nb, off) : { x: 0, y: 0 };
    if (!nb) return scale(own, off);
    const m = add(own, nb);
    const ml = Math.hypot(m.x, m.y);
    // Near-reversal: the bisector degenerates, so just use our own normal.
    if (ml < 1e-6) return scale(own, off);
    const u = scale(m, 1 / ml);
    const cos = u.x * own.x + u.y * own.y;
    return scale(u, off * Math.min(TRAIL_MITER_MAX, 1 / Math.max(cos, 1e-3)));
  };
  /**
   * Where a stop sits on screen (px). Endpoints follow the miter so they line
   * up with the neighbouring segment; stops inside the segment just ride its
   * own normal.
   */
  const stopPoint = (i: number, st: LaneStop): Vec => {
    const seg = trail[i];
    const base = lerp(seg.from, seg.to, st.t);
    const off = st.offset * s;
    const sh =
      st.t <= 0
        ? nodeShift(i, 'from', off)
        : st.t >= 1
          ? nodeShift(i, 'to', off)
          : scale(segNormal(i) ?? { x: 0, y: 0 }, off);
    return { x: base.x * s + sh.x, y: base.y * s + sh.y };
  };
  // Piecewise ramp through the pure car color at TRAIL_MID: below it we
  // darken (recede into the field), above it we lighten (pop out of it).
  const speedColor = (f: number): string =>
    shade(
      color,
      f < TRAIL_MID
        ? -(1 - TRAIL_DIM_MIN) * (1 - f / TRAIL_MID)
        : (TRAIL_LIGHTEN_MAX * (f - TRAIL_MID)) / (1 - TRAIL_MID),
    );

  /** Half-thickness (css px) of the ribbon at a node of the given factor. */
  const halfW = (f: number): number =>
    (TRAIL_WIDTH_MIN + (TRAIL_WIDTH_MAX - TRAIL_WIDTH_MIN) * f) / 2;

  ctx.save();
  ctx.globalAlpha = alpha;
  for (let i = 0; i < trail.length; i++) {
    const seg = trail[i];

    ctx.save();
    if (seg.jump) {
      // Jumps never take a lane: a dashed line straight between the nodes.
      ctx.strokeStyle = MUTED;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(seg.from.x * s, seg.from.y * s);
      ctx.lineTo(seg.to.x * s, seg.to.y * s);
      ctx.stroke();
      ctx.restore();
      continue;
    }

    const f0 = nodeFactor(i, 'from');
    const f1 = nodeFactor(i, 'to');
    const stops = lanes[i];
    // One piece per lane stop: the offset is constant or ramping between any
    // two of them, so a straight quad is exact.
    for (let k = 0; k + 1 < stops.length; k++) {
      const a = stops[k];
      const b = stops[k + 1];
      const pa = stopPoint(i, a);
      const pb = stopPoint(i, b);
      const fa = f0 + (f1 - f0) * a.t;
      const fb = f0 + (f1 - f0) * b.t;
      const wa = halfW(fa);
      const wb = halfW(fb);
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const len = Math.hypot(dx, dy);

      // A standing car makes a zero-length segment; a gradient with coincident
      // endpoints paints nothing, so such a dot gets a flat color.
      if (len === 0) {
        ctx.fillStyle = speedColor(fa);
      } else {
        const g = ctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
        g.addColorStop(0, speedColor(fa));
        g.addColorStop(1, speedColor(fb));
        ctx.fillStyle = g;
      }
      // Glow only on the fast half, so slow segments stay flat and quiet.
      const fg = (fa + fb) / 2;
      ctx.shadowBlur = 0;
      if (fg > TRAIL_MID) {
        ctx.shadowColor = color;
        ctx.shadowBlur = (TRAIL_GLOW_MAX * (fg - TRAIL_MID)) / (1 - TRAIL_MID);
      }

      if (len > 0) {
        // Left normal; the quad runs down one side and back up the other, so
        // its winding is consistent regardless of the piece's direction.
        const nx = -dy / len;
        const ny = dx / len;
        ctx.beginPath();
        ctx.moveTo(pa.x + nx * wa, pa.y + ny * wa);
        ctx.lineTo(pb.x + nx * wb, pb.y + ny * wb);
        ctx.lineTo(pb.x - nx * wb, pb.y - ny * wb);
        ctx.lineTo(pa.x - nx * wa, pa.y - ny * wa);
        ctx.closePath();
        ctx.fill();
      }
      // Round the ends/joins, and cover the kink where a ramp changes
      // direction. Filled separately so their winding can't punch a hole in
      // the quad under the nonzero rule.
      ctx.beginPath();
      ctx.arc(pa.x, pa.y, wa, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pb.x, pb.y, wb, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  for (const c of crashes) drawCrashMark(ctx, s, c, color);
  ctx.restore();
}

/**
 * Cars. Players who are out (finished in an earlier round, or retired) have
 * left the track — we don't draw their marker (and they don't block cells
 * either, see otherPositions). The trail stays behind as a record of their run.
 */
function drawCars(ctx: CanvasRenderingContext2D, s: number, game: GameState): void {
  for (const p of game.players) {
    if (p.place !== null || p.retired) continue;
    drawCarAt(ctx, s, p.pos, p.color);
  }
}

/**
 * One car marker at an arbitrary point — the position is a parameter rather
 * than read off the player, because during a replay or a post-move tween a car
 * sits between two nodes.
 */
export function drawCarAt(
  ctx: CanvasRenderingContext2D,
  s: number,
  pos: Vec,
  color: string,
): void {
  ctx.beginPath();
  ctx.arc(pos.x * s, pos.y * s, Math.max(4, s * 0.28), 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = HALO;
  ctx.lineWidth = CAR_STROKE_LW;
  ctx.stroke();
}

/** Current player's move candidates: traction zone, aim line, and points. */
/** What a candidate *is*, independent of whether it is currently selected. */
type CandKind = 'normal' | 'crash' | 'blocked';

function drawCandidates(
  ctx: CanvasRenderingContext2D,
  s: number,
  game: GameState,
  cands: Candidate[] | null,
  hover: Candidate | null,
  pending: Candidate | null,
  candSeat: number,
): void {
  if (!cands || candSeat < 0 || game.phase !== 'race') return;
  // Fan owner: on our turn it's whoever's moving, on the opponent's turn
  // (pre-pick) it's our own seat. Position, color, and the traction zone are
  // all taken from here, not from game.current.
  const p = game.players[candSeat];
  // Whose turn it actually is decides how loud the preview gets. The fan owner
  // differs from the mover exactly when we are pre-picking for a later turn
  // (bot or online opponent moving) — the same condition main.ts calls
  // `isPreselect`. In hotseat the two never diverge, so nothing dims there.
  // The preview recedes by losing luminance, never by fading into the field:
  // `shade(c, 0)` is the identity, so the active turn is untouched.
  const dim = candSeat === game.current ? 0 : PRESELECT_DIM;
  // Traction zone fill goes under the points; we skip it for isotropic
  // handling (like classic mode), where it's just an obvious square.
  const d = game.rules.drive;
  if (!(d.accel === d.brake && d.brake === d.grip && d.downforce === 0)) {
    drawDriveArea(ctx, s, p.pos, p.vel, d, shade(p.color, dim), DRIVE_AREA_ALPHA);
  }
  if (hover && !hover.blocked) {
    ctx.save();
    ctx.strokeStyle = shade(p.color, dim);
    ctx.globalAlpha = AIM_LINE_ALPHA;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.pos.x * s, p.pos.y * s);
    ctx.lineTo(hover.target.x * s, hover.target.y * s);
    ctx.stroke();
    ctx.restore();
  }
  for (const c of cands) {
    const x = c.target.x * s;
    const y = c.target.y * s;
    const r = Math.max(CAND_R_MIN, s * (c.inertial ? CAND_R_INERTIAL : CAND_R));
    // Two orthogonal axes: what the candidate *is* (kind) and what state it is
    // in (selected). Branching on them separately keeps a selected crash from
    // being shadowed by the crash styling.
    const kind: CandKind = c.blocked ? 'blocked' : c.crash ? 'crash' : 'normal';
    const selected = c === hover;
    // A car already sits on that cell — the marker says "you can't go here"
    // better than a cross would. Only a barred *path* to an otherwise free
    // cell needs marking, since nothing else on screen shows it.
    if (c.blockReason === 'occupied') continue;
    ctx.save();
    if (kind === 'blocked') {
      // Another car stands somewhere along the way — gray cross.
      const br = Math.max(BLOCK_R_MIN, s * BLOCK_R);
      ctx.strokeStyle = shade(MUTED, dim);
      ctx.lineWidth = BLOCK_LW;
      crossPath(ctx, x, y, br);
      ctx.stroke();
    } else {
      // Normal and crash candidates share one shape — a ring, plus a center dot
      // when selected — and differ only in color, so selection reads the same
      // way everywhere. Blocked candidates have no selected state: they are
      // filtered out of hit-testing and can never be picked.
      const color = shade(kind === 'crash' ? CRASH : EDGE, dim);
      ctx.strokeStyle = color;
      if (selected) {
        ctx.lineWidth = CAND_HOVER_LW;
      } else {
        ctx.globalAlpha = kind === 'crash' ? CRASH_CAND_ALPHA : CAND_ALPHA;
        ctx.lineWidth = kind === 'crash' ? CRASH_CAND_LW : CAND_LW;
        // A crash ring stays solid — it's a wall, not one option among many.
        if (kind === 'normal') ctx.setLineDash(CAND_DASH);
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      if (selected) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2, s * CAND_HOVER_DOT_R), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  // Pending pick (pre-selected for the opponent's turn): dashed ring + guide
  // line from the car — reads as "queued, not confirmed yet", distinct from
  // the solid selection shown on our own turn.
  if (pending) {
    const px = pending.target.x * s;
    const py = pending.target.y * s;
    const pr =
      Math.max(CAND_R_MIN, s * (pending.inertial ? CAND_R_INERTIAL : CAND_R)) +
      PENDING_R_PAD;
    ctx.save();
    ctx.lineWidth = PENDING_LW;
    ctx.setLineDash(PENDING_DASH);
    // The guide line keeps the player's color — it says whose plan this is.
    ctx.strokeStyle = p.color;
    ctx.globalAlpha = PENDING_LINE_ALPHA;
    ctx.beginPath();
    ctx.moveTo(p.pos.x * s, p.pos.y * s);
    ctx.lineTo(px, py);
    ctx.stroke();
    // The ring does not: in the player's own color it is red for seat 0, which
    // reads as an error rather than a queued move. Same cyan as a selection,
    // one step quieter, so the two are obviously the same gesture.
    ctx.strokeStyle = EDGE;
    ctx.globalAlpha = PENDING_RING_ALPHA;
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/** Path for a diagonal ✕ cross (radius r) — shared by crash marks and blocked cells. */
function crossPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x - r, y - r);
  ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r);
  ctx.lineTo(x - r, y + r);
}

function drawCrashMark(
  ctx: CanvasRenderingContext2D,
  s: number,
  at: Vec,
  color: string,
): void {
  const r = Math.max(CRASH_MARK_R_MIN, s * CRASH_MARK_R);
  const x = at.x * s;
  const y = at.y * s;
  ctx.lineCap = 'round';
  // Halo background under the cross — contrast against a same-colored trail.
  ctx.strokeStyle = HALO;
  ctx.lineWidth = CRASH_HALO_LW;
  crossPath(ctx, x, y, r);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = CRASH_STROKE_LW;
  crossPath(ctx, x, y, r);
  ctx.stroke();
}
