// Отрисовка обеих фаз на одном canvas: полная перерисовка по событию.

import { Vec, Polyline, add, sub, scale, normalize, lerp } from '../geometry';
import { Track } from '../model/track';
import { EditorState, Arrow } from '../model/editor';
import { GameState, Candidate, Drive, Player } from '../model/game';
import { aeroFactor } from '../model/turns';
import { MIN_LAUNCH } from '../config';
import { Camera } from './camera';

export interface AppView {
  mode: 'edit' | 'race';
  editor: EditorState;
  game: GameState | null;
  cands: Candidate[] | null;
  hover: Candidate | null;
  /** Кандидат, выбранный касанием и ждущий подтверждающего тапа. */
  selected: Candidate | null;
  /** Наметка: ход, предвыбранный своим местом в чужую очередь (онлайн/vs-боты),
   *  ждущий ручного «Газу!». Рисуется отдельным стилем (пунктирное кольцо). */
  pending: Candidate | null;
  /** Место-владелец веера кандидатов: в свой ход — game.current; в чужой ход при
   *  предвыборе — своё место. −1 — веера нет. */
  candSeat: number;
  /** Позиция пальца в css-пикселях canvas — включает «лупу» при прицеливании. */
  loupe: Vec | null;
  /** Камера: единый переход мир↔экран (масштаб + смещение). */
  cam: Camera;
}

// Палитра canvas-рендера — направление «blueprint»: тёмно-синее поле, голубая сетка,
// полотно дороги подсвечено ПОВЕРХ фона (см. дизайн «Paper Racing — Canvas System»).
// Раньше BG/EDGE/ACCENT зеркалили DOM-токены base.css (--paper/--ink/--accent). На
// этой фазе редизайна меняется только canvas; DOM пока остаётся кремовым, поэтому
// зеркала base.css СОЗНАТЕЛЬНО рассинхронены — их сведёт следующая фаза (DOM).
/** Фон поля (тёмно-синий «блюпринт»); также заливка лупы и база подмешивания следа. */
const BG = '#0d3252';
/** Кромка трассы и чертёж в редакторе — сплошная голубая линия поверх фона. */
const EDGE = '#7fd3ff';
/** Сетка поверх голого фона — едва заметная холодная голубая (жирная — каждые 5). */
const GRID_LIGHT = 'rgba(127, 211, 255, 0.08)';
const GRID_HEAVY = 'rgba(127, 211, 255, 0.16)';
/** Та же сетка, подсвеченная под полотном дороги (клип по кольцу трассы). */
const GRID_ROAD_LIGHT = 'rgba(127, 211, 255, 0.22)';
const GRID_ROAD_HEAVY = 'rgba(127, 211, 255, 0.36)';
/** Лёгкая голубая заливка-подсветка полотна дороги. */
const ROAD_WASH = 'rgba(127, 211, 255, 0.05)';
/** Янтарный акцент: стрелка направления и ручки перетаскивания в редакторе. */
const ACCENT = '#ffb454';
/** Нимб под болидом и крестиком — цвет фона, читается контрастом над следом. */
const HALO = '#0d3252';
/** Приглушённый серо-голубой: прыжок-сегмент следа и заблокированный кандидат. */
const MUTED = '#a7bdd0';
/** Голубое кольцо лупы. */
const LOUPE_RING = '#7fd3ff';
/** Осевая-подсказка в фазе тюнинга кромок (можно тянуть). */
const CENTERLINE_HINT = 'rgba(127, 211, 255, 0.5)';
/** Крест аварийного кандидата (красный). */
const CRASH = '#ff5d5d';
/** Клетки, тень и рамка клетчатого флага финиша (тёмная клетка = цвет фона). */
const FLAG_DARK = '#0d3252';
const FLAG_LIGHT = '#bfe6ff';
const FLAG_SHADOW = 'rgba(0,0,0,0.1)';
const FLAG_BORDER = 'rgba(127, 211, 255, 0.45)';

// Насыщенность и толщина следа растут со скоростью хода (длиной сегмента): быстрые
// прямые рисуются плотной жирной линией, медленное ковыряние в поворотах — бледной
// тонкой. Цвет — НЕПРОЗРАЧНЫЙ, подмешанный к бумаге (а не globalAlpha): так линия не
// даёт тёмных точек на стыках сегментов и в пересечениях с сеткой, где полупрозрачные
// штрихи накладывались бы вдвойне. TRAIL_SPEED_REF (клеток/ход) — скорость, при
// которой след уже максимально насыщенный.
const TRAIL_SPEED_REF = 6;
/** Доля цвета болида в фоне на самом медленном ходу (0 — почти фон). Подняли под
 *  тёмное поле «blueprint»: подмес к navy на малой доле давал мутный след без
 *  контраста; ~0.32 держит медленный след читаемым. */
const TRAIL_MIX_MIN = 0.32;
const TRAIL_WIDTH_MIN = 2;
const TRAIL_WIDTH_MAX = 3.6;

// Геометрия меток гонки. Радиусы масштабируются с `s` (px/клетку), толщины —
// константны в px, как в дизайне. Значения приведены к дизайну «Canvas System»
// (первично) и «Design Exploration» (для состояний, которых в CS нет); дизайн
// рисует на сетке 26px, поэтому `размер_px / 26` = доля от `s`. Вынесено сюда,
// чтобы подкручивать в одном месте.
/** Кандидат хода: голубое пунктирное кольцо (обычный / инерционный). */
const CAND_R = 0.27;
const CAND_R_INERTIAL = 0.34;
const CAND_R_MIN = 4;
const CAND_DASH: [number, number] = [3, 4];
const CAND_LW = 1.6;
const CAND_ALPHA = 0.85;
/** Наведённый/выбранный кандидат: сплошное кольцо + точка в центре. */
const CAND_HOVER_LW = 2;
const CAND_HOVER_DOT_R = 0.12;
/** Заблокированный узел: серый крестик. */
const BLOCK_R = 0.23;
const BLOCK_R_MIN = 3.5;
const BLOCK_LW = 1.8;
/** Кандидат-авария (ход в стену): сплошное красное кольцо. */
const CRASH_CAND_LW = 2;
/** Отметка аварии на следе: нимб-фон + красный крест. */
const CRASH_MARK_R = 0.27;
const CRASH_MARK_R_MIN = 4;
const CRASH_HALO_LW = 4.5;
const CRASH_STROKE_LW = 2.2;
/** Обводка болида (нимб-фон поверх следа). */
const CAR_STROKE_LW = 2;

/** Линейная интерполяция двух hex-цветов (#rrggbb) → непрозрачный rgb(). */
function mixHex(a: string, b: string, t: number): string {
  const pa = [
    parseInt(a.slice(1, 3), 16),
    parseInt(a.slice(3, 5), 16),
    parseInt(a.slice(5, 7), 16),
  ];
  const pb = [
    parseInt(b.slice(1, 3), 16),
    parseInt(b.slice(3, 5), 16),
    parseInt(b.slice(5, 7), 16),
  ];
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

export function render(ctx: CanvasRenderingContext2D, app: AppView): void {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = ctx.canvas.width / dpr;
  const h = ctx.canvas.height / dpr;
  const s = app.cam.scale;

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  // Сцена рисуется под камерой (зум/пан); лупа — поверх, в экранных координатах.
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
 * «Лупа» для тач-прицеливания: увеличенный фрагмент сцены вокруг точки
 * касания, вынесенный выше пальца, чтобы палец его не закрывал.
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
  // Мировая точка под пальцем (с учётом камеры) — в центр лупы.
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
 * Бесконечная сетка: рисуем только линии, попадающие в видимое окно
 * [vx0..vx1] × [vy0..vy1] (экранные css-px). ctx уже сдвинут на (ox, oy), поэтому
 * узел мира n рисуется в координате n*s. Жирная линия — каждые 5 клеток
 * (корректно и для отрицательных координат).
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

/** Добавить замкнутый контур полилинии в текущий path (без заливки/обводки). */
function addPolyPath(ctx: CanvasRenderingContext2D, s: number, poly: Polyline): void {
  if (poly.length < 2) return;
  ctx.moveTo(poly[0].x * s, poly[0].y * s);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * s, poly[i].y * s);
  ctx.closePath();
}

/**
 * Полотно трассы «blueprint»: дорога рисуется ПОВЕРХ фона, а не вычитается из него.
 * Внетрассовая территория остаётся голым тёмным фоном (уже залит в render). Полотно —
 * кольцо между outer и inner (без inner — вся внутренность outer): лёгкая голубая
 * подсветка + сетка, усиленная под клипом кольца, + сплошная голубая кромка.
 */
function drawRoadSurface(
  ctx: CanvasRenderingContext2D,
  s: number,
  outer: Polyline | null,
  inner: Polyline | null,
): void {
  if (!outer) return;
  // Путь полотна: кольцо outer/inner (even-odd); без inner — вся внутренность outer.
  const ringPath = (): void => {
    ctx.beginPath();
    addPolyPath(ctx, s, outer);
    if (inner) addPolyPath(ctx, s, inner);
  };

  // 1) Лёгкая голубая подсветка полотна.
  ctx.save();
  ctx.fillStyle = ROAD_WASH;
  ringPath();
  ctx.fill('evenodd');
  ctx.restore();

  // 2) Усиленная сетка под полотном — клип по кольцу поверх бледной фоновой сетки.
  //    ctx уже сдвинут на (cam.ox, cam.oy) в render; линии сетки стоят на worldNode*s
  //    независимо от сдвига, поэтому здесь передаём ox/oy=0 и окно в этих же translated-
  //    координатах (bbox внешней кромки, с запасом в клетку). Клип отсекает лишнее.
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

  // 3) Сплошная голубая кромка по обеим границам полотна.
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
  // Слегка отступаем от краёв трассы, чтобы прямоугольная полоса не
  // вылезала за изогнутую кромку у самых точек a/b.
  const inset = Math.min(lenPx * 0.15, bandHalf);
  const usableLen = Math.max(cell, lenPx - inset * 2);
  const ax = a.x * s + dir.x * inset;
  const ay = a.y * s + dir.y * inset;
  const cols = Math.max(1, Math.round(usableLen / cell));
  const actualCell = usableLen / cols;

  ctx.save();
  // Лёгкая тень под флагом для объёма.
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

  // Тонкая рамка по периметру полосы для аккуратного края.
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

function drawArrow(
  ctx: CanvasRenderingContext2D,
  s: number,
  from: Vec,
  tip: Vec,
  color: string,
  width: number,
): void {
  const d = normalize(sub(tip, from));
  const n = { x: -d.y, y: d.x };
  const headBase = sub(tip, scale(d, 0.5));
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(from.x * s, from.y * s);
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
  // В фазе тюнинга — слабая осевая как подсказка, что кромки можно тянуть.
  if (ed.step === 'adjust' && ed.center) {
    ctx.save();
    ctx.strokeStyle = CENTERLINE_HINT;
    ctx.lineWidth = 1;
    ctx.setLineDash([s * 0.25, s * 0.25]);
    strokePoly(ctx, s, ed.center, true);
    ctx.restore();
  }

  // С фазы «adjust» кромки уже замкнуты — показываем ту же визуализацию, что и в
  // гонке: полупрозрачную заливку внетрассовой территории со светло-серой кромкой.
  // В фазе «center» (черчение осевой) заливки ещё нет — рисуем простой контур.
  if (ed.step !== 'center' && ed.outer && ed.inner) {
    drawRoadSurface(ctx, s, ed.outer, ed.inner);
  } else {
    drawTrackEdges(ctx, s, ed.outer, ed.inner);
  }

  // Активная перетаскиваемая точка кромки.
  if (ed.step === 'adjust' && ed.dragEdge && ed.dragIndex !== null) {
    const edge = ed.dragEdge === 'outer' ? ed.outer : ed.inner;
    const pt = edge?.[ed.dragIndex];
    if (pt) {
      ctx.save();
      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.arc(pt.x * s, pt.y * s, Math.max(4, s * 0.22), 0, Math.PI * 2);
      ctx.fill();
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

  if (ed.finish) drawFinishLine(ctx, s, ed.finish.a, ed.finish.b);

  // Точка касания в фазе старт/финиша — куда «пришпилена» перпендикулярная черта.
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
    for (const arrow of ed.arrows) drawArrow(ctx, s, arrow.from, arrow.tip, ACCENT, 2.5);
  }

  if (ed.step === 'ready' && ed.arrows && ed.forward) {
    const chosen = ed.arrows.find(
      (a: Arrow) => a.forward.x === ed.forward!.x && a.forward.y === ed.forward!.y,
    );
    if (chosen) drawArrow(ctx, s, chosen.from, chosen.tip, ACCENT, 2.5);
  }
}

/**
 * Заливка «эллипса сцепления» управляемости — зоны вокруг точки наката C = pos + vel,
 * внутри которой лежат точки-кандидаты. В системе координат скорости: перёд —
 * полуэллипс с полуосями (accel × grip_eff), зад — (brake_eff × grip_eff); на старте
 * (vel = 0) — круг радиуса max(accel, MIN_LAUNCH). Торможение и хват берутся с учётом
 * прижима на текущей скорости (grip_eff/brake_eff = grip/brake · aeroFactor), чтобы
 * заливка совпадала с фактически достижимыми узлами. Рисуется бледной заливкой без
 * обводки — обозначить границу с минимумом шума.
 */
function drawDriveArea(
  ctx: CanvasRenderingContext2D,
  s: number,
  pos: Vec,
  vel: Vec,
  drive: Drive,
  color: string,
): void {
  const { accel, brake, grip, downforce } = drive;
  const speed = Math.hypot(vel.x, vel.y);
  const aero = aeroFactor(downforce, speed);
  const brakeEff = brake * aero;
  const gripEff = grip * aero;
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.1;
  ctx.beginPath();
  if (speed === 0) {
    ctx.arc(pos.x * s, pos.y * s, Math.max(accel, MIN_LAUNCH) * s, 0, Math.PI * 2);
  } else {
    const cx = (pos.x + vel.x) * s;
    const cy = (pos.y + vel.y) * s;
    const phi = Math.atan2(vel.y, vel.x); // продольная ось = направление движения
    // Две полудуги эллипса, стыкующиеся по поперечной оси (углы ±π/2): передняя с
    // полуосью accel вдоль движения, задняя с brake_eff; обе с grip_eff вбок.
    ctx.ellipse(cx, cy, accel * s, gripEff * s, phi, -Math.PI / 2, Math.PI / 2);
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
  for (const p of game.players) drawTrail(ctx, s, p);
  drawCars(ctx, s, game);
  drawCandidates(ctx, s, game, cands, hover, pending, candSeat);
}

/** Статичный декор трассы: полотно дороги, финиш и стрелка направления. */
function drawTrackDecor(ctx: CanvasRenderingContext2D, s: number, track: Track): void {
  drawRoadSurface(ctx, s, track.outer, track.inner);
  drawFinishLine(ctx, s, track.finish.a, track.finish.b);

  // Стрелка направления гонки у финишной линии.
  const m = lerp(track.finish.a, track.finish.b, 0.5);
  drawArrow(
    ctx,
    s,
    add(m, scale(track.forward, 0.8)),
    add(m, scale(track.forward, 2.0)),
    ACCENT,
    2.4,
  );
}

/**
 * След одного игрока плюс отметки аварий. Насыщенность и толщина следа растут
 * со скоростью хода; чтобы цвет менялся плавно вдоль трассы, а не ступенькой на
 * каждой границе ходов, каждый сегмент заливаем линейным градиентом между
 * «цветами скорости» в его узлах-концах. Фактор в узле — среднее скоростей
 * примыкающих сегментов (если сосед есть, не «прыжок» и делит с сегментом этот
 * узел), иначе — скорость самого сегмента.
 */
function drawTrail(ctx: CanvasRenderingContext2D, s: number, p: Player): void {
  const trail = p.trail;
  // Фактор насыщенности 0..1 по скорости сегмента. Степень >1 растягивает
  // разрыв между медленным и быстрым ходом — контраст резче.
  const segFactor = (i: number): number => {
    const seg = trail[i];
    const speed = Math.hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y);
    return Math.pow(Math.min(1, speed / TRAIL_SPEED_REF), 1.5);
  };
  const colorAt = (f: number): string =>
    mixHex(BG, p.color, TRAIL_MIX_MIN + (1 - TRAIL_MIX_MIN) * f);
  const connected = (
    a: { to: Vec; jump?: boolean },
    b: { from: Vec; jump?: boolean },
  ): boolean => !a.jump && !b.jump && a.to.x === b.from.x && a.to.y === b.from.y;

  for (let i = 0; i < trail.length; i++) {
    const seg = trail[i];
    ctx.save();
    if (seg.jump) {
      ctx.strokeStyle = MUTED;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
    } else {
      const f = segFactor(i);
      // Фактор в концах — усреднён с соседним сегментом, чтобы цвет перетекал
      // через границу хода без скачка.
      const fFrom =
        i > 0 && connected(trail[i - 1], seg) ? (segFactor(i - 1) + f) / 2 : f;
      const fTo =
        i + 1 < trail.length && connected(seg, trail[i + 1])
          ? (f + segFactor(i + 1)) / 2
          : f;
      const grad = ctx.createLinearGradient(
        seg.from.x * s,
        seg.from.y * s,
        seg.to.x * s,
        seg.to.y * s,
      );
      grad.addColorStop(0, colorAt(fFrom));
      grad.addColorStop(1, colorAt(fTo));
      ctx.strokeStyle = grad;
      ctx.lineWidth = TRAIL_WIDTH_MIN + (TRAIL_WIDTH_MAX - TRAIL_WIDTH_MIN) * f;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }
    ctx.beginPath();
    ctx.moveTo(seg.from.x * s, seg.from.y * s);
    ctx.lineTo(seg.to.x * s, seg.to.y * s);
    ctx.stroke();
    ctx.restore();
  }
  for (const c of p.crashes) drawCrashMark(ctx, s, c, p.color);
}

/**
 * Болиды. Выбывшие (получили место в разрешённом раунде или сдались) ушли с
 * трассы — их маркер не рисуем (и клетки они не блокируют, см. otherPositions).
 * След остаётся как история проезда.
 */
function drawCars(ctx: CanvasRenderingContext2D, s: number, game: GameState): void {
  for (const p of game.players) {
    if (p.place !== null || p.retired) continue;
    ctx.beginPath();
    ctx.arc(p.pos.x * s, p.pos.y * s, Math.max(4, s * 0.28), 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.strokeStyle = HALO;
    ctx.lineWidth = CAR_STROKE_LW;
    ctx.stroke();
  }
}

/** Кандидаты хода текущего игрока: зона сцепления, линия наведения и точки. */
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
  // Владелец веера: в свой ход — ходящий, в чужой (предвыбор) — своё место. Позиция,
  // цвет и зона сцепления берутся отсюда, а не от game.current.
  const p = game.players[candSeat];
  // Заливка зоны сцепления — под точками; изотропную управляемость (как классика)
  // не рисуем, там квадрат и так очевиден.
  const d = game.rules.drive;
  if (!(d.accel === d.brake && d.brake === d.grip && d.downforce === 0)) {
    drawDriveArea(ctx, s, p.pos, p.vel, d, p.color);
  }
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
    const r = Math.max(CAND_R_MIN, s * (c.inertial ? CAND_R_INERTIAL : CAND_R));
    if (c.blocked) {
      // Занятый узел — серый крестик.
      const br = Math.max(BLOCK_R_MIN, s * BLOCK_R);
      ctx.strokeStyle = MUTED;
      ctx.lineWidth = BLOCK_LW;
      crossPath(ctx, x, y, br);
      ctx.stroke();
    } else if (c.crash) {
      // Ход в стену — сплошное красное кольцо (отличается от голубого «можно»).
      ctx.strokeStyle = CRASH;
      ctx.lineWidth = CRASH_CAND_LW;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
    } else if (c === hover) {
      // Наведён/выбран: сплошное (без пунктира) кольцо + точка в центре, полная
      // непрозрачность — фокус среди пунктирного веера.
      ctx.save();
      ctx.strokeStyle = EDGE;
      ctx.lineWidth = CAND_HOVER_LW;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = EDGE;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(2, s * CAND_HOVER_DOT_R), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      // Доступный ход — голубое пунктирное кольцо (яркий контраст на тёмном поле).
      ctx.save();
      ctx.strokeStyle = EDGE;
      ctx.globalAlpha = CAND_ALPHA;
      ctx.lineWidth = CAND_LW;
      ctx.setLineDash(CAND_DASH);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
  // Наметка (предвыбор в чужую очередь): пунктирное кольцо + направляющая от болида —
  // «намечено, ещё не подтверждено», отличается от сплошного выбора на своём ходу.
  if (pending) {
    const px = pending.target.x * s;
    const py = pending.target.y * s;
    const pr =
      Math.max(CAND_R_MIN, s * (pending.inertial ? CAND_R_INERTIAL : CAND_R)) + 3;
    ctx.save();
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(p.pos.x * s, p.pos.y * s);
    ctx.lineTo(px, py);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/** Путь диагонального крестика ✕ (радиус r) — общий для аварии и блок-клетки. */
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
  // Нимб-фон под крестиком — контраст над следом того же цвета.
  ctx.strokeStyle = HALO;
  ctx.lineWidth = CRASH_HALO_LW;
  crossPath(ctx, x, y, r);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = CRASH_STROKE_LW;
  crossPath(ctx, x, y, r);
  ctx.stroke();
}
