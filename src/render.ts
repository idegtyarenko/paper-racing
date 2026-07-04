// Отрисовка обеих фаз на одном canvas: полная перерисовка по событию.

import { Vec, Polyline, add, sub, scale, normalize, lerp } from './geometry';
import { WORLD_W, WORLD_H, Track } from './track';
import { EditorState, Arrow } from './editor';
import { GameState, Candidate } from './game';

export interface AppView {
  mode: 'edit' | 'race';
  editor: EditorState;
  game: GameState | null;
  cands: Candidate[] | null;
  hover: Candidate | null;
  /** Кандидат, выбранный касанием и ждущий подтверждающего тапа. */
  selected: Candidate | null;
  /** Позиция пальца в css-пикселях canvas — включает «лупу» при прицеливании. */
  loupe: Vec | null;
  cellPx: number;
}

const INK = '#3a3a3a';
const PAPER = '#fbfaf4';
const GRID_LIGHT = '#e2e8f2';
const GRID_HEAVY = '#c9d6e8';
const ARROW_COLOR = '#0a8a4f';

export function render(ctx: CanvasRenderingContext2D, app: AppView): void {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = ctx.canvas.width / dpr;
  const h = ctx.canvas.height / dpr;
  const s = app.cellPx;

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);
  drawGrid(ctx, s);

  if (app.mode === 'edit') {
    drawEditor(ctx, s, app.editor);
  } else if (app.game) {
    drawRace(ctx, s, app.game, app.cands, app.hover ?? app.selected);
    if (app.loupe) drawLoupe(ctx, app, w, h);
  }
}

/**
 * «Лупа» для тач-прицеливания: увеличенный фрагмент сцены вокруг точки
 * касания, вынесенный выше пальца, чтобы палец его не закрывал.
 */
function drawLoupe(ctx: CanvasRenderingContext2D, app: AppView, w: number, h: number): void {
  const R = 64;
  const ZOOM = 3;
  const p = app.loupe!;
  const cx = Math.min(Math.max(p.x, R + 4), Math.max(R + 4, w - R - 4));
  const cy = Math.max(p.y - R - 36, R + 4);
  const s2 = app.cellPx * ZOOM;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = PAPER;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  // Мировая точка под пальцем — в центр лупы.
  ctx.translate(cx - (p.x / app.cellPx) * s2, cy - (p.y / app.cellPx) * s2);
  drawGrid(ctx, s2);
  drawRace(ctx, s2, app.game!, app.cands, app.hover ?? app.selected);
  ctx.restore();

  ctx.strokeStyle = '#55524a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
}

function drawGrid(ctx: CanvasRenderingContext2D, s: number): void {
  const w = WORLD_W * s;
  const h = WORLD_H * s;
  for (let x = 0; x <= WORLD_W; x++) {
    ctx.strokeStyle = x % 5 === 0 ? GRID_HEAVY : GRID_LIGHT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x * s, 0);
    ctx.lineTo(x * s, h);
    ctx.stroke();
  }
  for (let y = 0; y <= WORLD_H; y++) {
    ctx.strokeStyle = y % 5 === 0 ? GRID_HEAVY : GRID_LIGHT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y * s);
    ctx.lineTo(w, y * s);
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

function drawTrackEdges(ctx: CanvasRenderingContext2D, s: number, outer: Polyline | null, inner: Polyline | null): void {
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (outer) strokePoly(ctx, s, outer, true);
  if (inner) strokePoly(ctx, s, inner, true);
}

function drawFinishLine(ctx: CanvasRenderingContext2D, s: number, a: Vec, b: Vec): void {
  ctx.save();
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 3;
  ctx.setLineDash([s * 0.35, s * 0.3]);
  ctx.beginPath();
  ctx.moveTo(a.x * s, a.y * s);
  ctx.lineTo(b.x * s, b.y * s);
  ctx.stroke();
  ctx.restore();
}

function drawArrow(ctx: CanvasRenderingContext2D, s: number, from: Vec, tip: Vec, color: string, width: number): void {
  const d = normalize(sub(tip, from));
  const n = { x: -d.y, y: d.x };
  const headBase = sub(tip, scale(d, 0.8));
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(from.x * s, from.y * s);
  ctx.lineTo(headBase.x * s, headBase.y * s);
  ctx.stroke();
  const l = add(headBase, scale(n, 0.45));
  const r = sub(headBase, scale(n, 0.45));
  ctx.beginPath();
  ctx.moveTo(tip.x * s, tip.y * s);
  ctx.lineTo(l.x * s, l.y * s);
  ctx.lineTo(r.x * s, r.y * s);
  ctx.closePath();
  ctx.fill();
}

function drawEditor(ctx: CanvasRenderingContext2D, s: number, ed: EditorState): void {
  // В фазе тюнинга — слабая осевая как подсказка, что кромки можно тянуть.
  if (ed.phase === 'adjust' && ed.center) {
    ctx.save();
    ctx.strokeStyle = '#b9c3d1';
    ctx.lineWidth = 1;
    ctx.setLineDash([s * 0.25, s * 0.25]);
    strokePoly(ctx, s, ed.center, true);
    ctx.restore();
  }

  drawTrackEdges(ctx, s, ed.outer, ed.inner);

  // Активная перетаскиваемая точка кромки.
  if (ed.phase === 'adjust' && ed.dragEdge && ed.dragIndex !== null) {
    const edge = ed.dragEdge === 'outer' ? ed.outer : ed.inner;
    const pt = edge?.[ed.dragIndex];
    if (pt) {
      ctx.save();
      ctx.fillStyle = ARROW_COLOR;
      ctx.beginPath();
      ctx.arc(pt.x * s, pt.y * s, Math.max(4, s * 0.22), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  if (ed.drawing && ed.stroke.length > 1) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.75;
    strokePoly(ctx, s, ed.stroke, false);
    ctx.globalAlpha = 1;
  }

  if (ed.finish) drawFinishLine(ctx, s, ed.finish.a, ed.finish.b);

  // Точка касания в фазе старт/финиша — куда «пришпилена» перпендикулярная черта.
  if (ed.phase === 'finish' && ed.dragStart) {
    ctx.save();
    ctx.fillStyle = ARROW_COLOR;
    ctx.beginPath();
    ctx.arc(ed.dragStart.x * s, ed.dragStart.y * s, Math.max(4, s * 0.22), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (ed.phase === 'direction' && ed.arrows) {
    for (const arrow of ed.arrows) drawArrow(ctx, s, arrow.from, arrow.tip, ARROW_COLOR, 4);
  }

  if (ed.phase === 'ready' && ed.arrows && ed.forward) {
    const chosen = ed.arrows.find(
      (a: Arrow) => a.forward.x === ed.forward!.x && a.forward.y === ed.forward!.y,
    );
    if (chosen) drawArrow(ctx, s, chosen.from, chosen.tip, ARROW_COLOR, 4);
  }
}

function drawRace(
  ctx: CanvasRenderingContext2D,
  s: number,
  game: GameState,
  cands: Candidate[] | null,
  hover: Candidate | null,
): void {
  const track: Track = game.track;
  drawTrackEdges(ctx, s, track.outer, track.inner);
  drawFinishLine(ctx, s, track.finish.a, track.finish.b);

  // Стрелка направления гонки у финишной линии.
  const m = lerp(track.finish.a, track.finish.b, 0.5);
  drawArrow(ctx, s, add(m, scale(track.forward, 0.8)), add(m, scale(track.forward, 2.6)), ARROW_COLOR, 2.5);

  // Следы обоих игроков.
  for (const p of game.players) {
    for (const seg of p.trail) {
      ctx.save();
      if (seg.jump) {
        ctx.strokeStyle = '#999';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
      } else {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2;
      }
      ctx.beginPath();
      ctx.moveTo(seg.from.x * s, seg.from.y * s);
      ctx.lineTo(seg.to.x * s, seg.to.y * s);
      ctx.stroke();
      ctx.restore();
    }
    for (const c of p.crashes) drawCrashMark(ctx, s, c);
  }

  // Болиды.
  for (const p of game.players) {
    ctx.beginPath();
    ctx.arc(p.pos.x * s, p.pos.y * s, Math.max(4, s * 0.28), 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Кандидаты хода текущего игрока.
  if (cands && game.phase === 'race') {
    const p = game.players[game.current];
    if (hover && !hover.blocked) {
      ctx.save();
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = 0.35;
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
      const r = Math.max(3, s * (c.inertial ? 0.2 : 0.14));
      if (c.blocked) {
        ctx.strokeStyle = '#999';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x - r, y - r);
        ctx.lineTo(x + r, y + r);
        ctx.moveTo(x + r, y - r);
        ctx.lineTo(x - r, y + r);
        ctx.stroke();
      } else if (c.crash) {
        ctx.strokeStyle = '#d32f2f';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // Кандидаты — полупрозрачные, чтобы отличаться от болида и выбранной
        // точки; наведённый/выбранный кандидат рисуем непрозрачным.
        ctx.save();
        ctx.globalAlpha = c === hover ? 1 : 0.4;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      if (c === hover && !c.blocked) {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}

function drawCrashMark(ctx: CanvasRenderingContext2D, s: number, at: Vec): void {
  const r = Math.max(4, s * 0.25);
  const x = at.x * s;
  const y = at.y * s;
  ctx.strokeStyle = '#b3261e';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - r, y - r);
  ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r);
  ctx.lineTo(x - r, y + r);
  ctx.stroke();
}
