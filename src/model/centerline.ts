// Построение трассы по осевой линии: случайная плавная ширина откладывается от
// осевой в обе стороны, с локальным ужиманием, чтобы кромки не налезали ни на
// себя, ни на соседние части трассы. Плюс перестроение кромок после ручного
// тюнинга (перетаскивание точек кромки).

import {
  Vec,
  Polyline,
  add,
  sub,
  scale,
  dot,
  cross,
  len,
  dist,
  normalize,
  closedNormals,
  distPointToSegment,
  selfIntersectsClosed,
  pointInPolygon,
  segmentPolylineIntersections,
  resampleClosed,
  smoothClosed,
} from '../geometry';
import { strings } from '../strings';
import { WIDTH_MIN, WIDTH_MAX, WORLD_SIZE } from '../config';

// Диапазон полной ширины трассы (клетки) — реэкспорт из config для внешних импортов.
export { WIDTH_MIN, WIDTH_MAX };

/** Нижний предел половины ширины: у́же — и на дороге не останется клеток. */
const HALF_MIN = 0.7;
/** Зазор «травы» между близко проходящими частями трассы, клетки. */
const SELF_GAP = 1.0;
/** Доля радиуса кривизны, до которой разрешено смещать вогнутую кромку. */
const CURV_SAFETY = 0.85;
/** Отступ кромки от края поля. */
const WORLD_MARGIN = 0.3;
/** Сглаживание итоговой кромки: число проходов и сила (0..1). */
const EDGE_SMOOTH_ITERS = 4;
const EDGE_SMOOTH_FACTOR = 0.5;
/** Целевой шаг ресемплинга осевой: держит число вершин в разумных пределах. */
const CENTER_MAX_VERTS = 380;

/** Данные ширины трассы: осевая, нормали и смещения кромок в каждой вершине. */
export interface WidthModel {
  center: Polyline;
  /** Единичная нормаль наружу в каждой вершине осевой. */
  outNormal: Vec[];
  /** Смещение от осевой до внешней кромки в каждой вершине. */
  outW: number[];
  /** Смещение от осевой до внутренней кромки в каждой вершине. */
  inW: number[];
}

/** Верхние пределы смещения кромок в вершине (близость, кривизна, край поля). */
export interface OffsetCaps {
  maxOut: number[];
  maxIn: number[];
}

/** Кумулятивная длина дуги по вершинам замкнутой полилинии + полная длина. */
function arcLengths(poly: Polyline): { cum: number[]; total: number } {
  const n = poly.length;
  const cum: number[] = new Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    cum[i] = s;
    s += dist(poly[i], poly[(i + 1) % n]);
  }
  return { cum, total: s };
}

/** Кратчайшее расстояние по кольцу между двумя позициями дуги. */
function arcGap(a: number, b: number, total: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, total - d);
}

/**
 * Случайная полная ширина в каждой вершине: несколько контрольных значений,
 * равномерно по дуге, плавно интерполированных по кольцу и сглаженных.
 */
function randomWidths(center: Polyline): number[] {
  const n = center.length;
  const { total } = arcLengths(center);
  const k = Math.max(3, Math.round(total / 12));
  const ctrl = Array.from(
    { length: k },
    () => WIDTH_MIN + Math.random() * (WIDTH_MAX - WIDTH_MIN),
  );
  const w: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const f = (i / n) * k; // позиция вершины в шкале контрольных точек
    const i0 = Math.floor(f) % k;
    const i1 = (i0 + 1) % k;
    // Косинусная интерполяция между соседними контрольными значениями.
    const t = (1 - Math.cos((f - Math.floor(f)) * Math.PI)) / 2;
    w[i] = ctrl[i0] + (ctrl[i1] - ctrl[i0]) * t;
  }
  return smoothRing(w, 2);
}

/** Сглаживание кольцевого массива усреднением с соседями. */
function smoothRing(arr: number[], iterations: number): number[] {
  const n = arr.length;
  let a = arr;
  for (let it = 0; it < iterations; it++) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = (a[(i - 1 + n) % n] + 2 * a[i] + a[(i + 1) % n]) / 4;
    }
    a = out;
  }
  return a;
}

/**
 * Максимальное смещение от точки p вдоль единичного направления d до границы
 * поля (с отступом WORLD_MARGIN). Возвращает Infinity, если направление не
 * приближает ни к одной границе.
 */
function worldCap(p: Vec, d: Vec): number {
  let t = Infinity;
  if (d.x > 1e-9) t = Math.min(t, (WORLD_SIZE - WORLD_MARGIN - p.x) / d.x);
  else if (d.x < -1e-9) t = Math.min(t, (WORLD_MARGIN - p.x) / d.x);
  if (d.y > 1e-9) t = Math.min(t, (WORLD_SIZE - WORLD_MARGIN - p.y) / d.y);
  else if (d.y < -1e-9) t = Math.min(t, (WORLD_MARGIN - p.y) / d.y);
  return Math.max(0, t);
}

/**
 * Пределы смещения кромок в каждой вершине:
 *  - близость к другим частям трассы (петля рядом сама с собой);
 *  - радиус кривизны на вогнутой стороне (крутой поворот);
 *  - край поля.
 */
export function offsetCaps(center: Polyline, outNormal: Vec[]): OffsetCaps {
  const n = center.length;
  const { cum, total } = arcLengths(center);
  const maxOut = new Array(n).fill(Infinity);
  const maxIn = new Array(n).fill(Infinity);
  // Не считать «другой частью» сегменты ближе этого по дуге (свои же соседи).
  const nearArc = WIDTH_MAX * 1.5;

  for (let i = 0; i < n; i++) {
    const p = center[i];

    // 1. Близость к несоседним частям осевой: обе кромки делят зазор пополам.
    let dSelf = Infinity;
    for (let j = 0; j < n; j++) {
      const midArc = (cum[j] + cum[(j + 1) % n]) / 2;
      if (arcGap(cum[i], midArc, total) < nearArc) continue;
      dSelf = Math.min(dSelf, distPointToSegment(p, center[j], center[(j + 1) % n]));
    }
    if (dSelf < Infinity) {
      const half = Math.max(HALF_MIN, (dSelf - SELF_GAP) / 2);
      maxOut[i] = Math.min(maxOut[i], half);
      maxIn[i] = Math.min(maxIn[i], half);
    }

    // 2. Кривизна: смещение на вогнутую сторону ограничено радиусом поворота.
    const prev = center[(i - 1 + n) % n];
    const next = center[(i + 1) % n];
    const eIn = sub(p, prev);
    const eOut = sub(next, p);
    const li = len(eIn);
    const lo = len(eOut);
    if (li > 1e-6 && lo > 1e-6) {
      const din = scale(eIn, 1 / li);
      const dout = scale(eOut, 1 / lo);
      const theta = Math.atan2(Math.abs(cross(din, dout)), dot(din, dout));
      if (theta > 1e-3) {
        const R = (li + lo) / 2 / theta; // радиус кривизны
        const cap = Math.max(HALF_MIN, CURV_SAFETY * R);
        // Вогнутая сторона — куда указывает биссектриса поворота.
        const bis = add(scale(din, -1), dout); // ≈ направление к центру кривизны
        if (dot(bis, outNormal[i]) > 0) maxOut[i] = Math.min(maxOut[i], cap);
        else maxIn[i] = Math.min(maxIn[i], cap);
      }
    }

    // 3. Край поля.
    maxOut[i] = Math.min(maxOut[i], worldCap(p, outNormal[i]));
    maxIn[i] = Math.min(maxIn[i], worldCap(p, scale(outNormal[i], -1)));
  }
  return { maxOut, maxIn };
}

/**
 * Построение кромок по осевой, нормалям и смещениям с финальным сглаживанием,
 * чтобы граница всегда была плавной линией (без острых углов и зазубрин от
 * шума ширины или стыка росчерка). Число вершин сохраняется — индексы кромок
 * соответствуют вершинам осевой (нужно для перетаскивания).
 */
export function offsetEdges(
  center: Polyline,
  outNormal: Vec[],
  outW: number[],
  inW: number[],
): { outer: Polyline; inner: Polyline } {
  const outer: Polyline = [];
  const inner: Polyline = [];
  for (let i = 0; i < center.length; i++) {
    outer.push(add(center[i], scale(outNormal[i], outW[i])));
    inner.push(sub(center[i], scale(outNormal[i], inW[i])));
  }
  return {
    outer: smoothClosed(outer, EDGE_SMOOTH_ITERS, EDGE_SMOOTH_FACTOR),
    inner: smoothClosed(inner, EDGE_SMOOTH_ITERS, EDGE_SMOOTH_FACTOR),
  };
}

/** Все вершины внутри поля (с учётом отступа). */
function withinWorld(poly: Polyline): boolean {
  for (const p of poly) {
    if (p.x < 0 || p.y < 0 || p.x > WORLD_SIZE || p.y > WORLD_SIZE) return false;
  }
  return true;
}

/** Кромки валидны: в поле, каждая проста, внутренняя вложена без пересечений. */
export function edgesValid(outer: Polyline, inner: Polyline): boolean {
  if (!withinWorld(outer) || !withinWorld(inner)) return false;
  if (selfIntersectsClosed(outer) || selfIntersectsClosed(inner)) return false;
  for (const p of inner) if (!pointInPolygon(p, outer)) return false;
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i];
    const b = inner[(i + 1) % inner.length];
    if (segmentPolylineIntersections(a, b, outer).length > 0) return false;
  }
  return true;
}

export type GenerateResult =
  { model: WidthModel; outer: Polyline; inner: Polyline } | { error: string };

/**
 * Генерация кромок из осевой линии: случайная ширина, ужатая до пределов
 * близости/кривизны/края. Если после клампа кромки всё же где-то пересекаются,
 * несколько раз слегка ужимаем ширину глобально; иначе — ошибка.
 */
export function generateEdges(centerRaw: Polyline): GenerateResult {
  // Ресемпл держит число вершин ограниченным (быстрый драг) и равномерным.
  const { total } = arcLengths(centerRaw);
  const center = resampleClosed(centerRaw, Math.max(1, total / CENTER_MAX_VERTS));
  const outNormal = closedNormals(center);
  const caps = offsetCaps(center, outNormal);
  const w = randomWidths(center);
  const n = center.length;

  const clampCaps = (arr: number[], cap: number[]): void => {
    for (let i = 0; i < n; i++) arr[i] = Math.max(HALF_MIN, Math.min(arr[i], cap[i]));
  };

  let outW = new Array(n);
  let inW = new Array(n);
  for (let i = 0; i < n; i++) outW[i] = inW[i] = w[i] / 2;
  clampCaps(outW, caps.maxOut);
  clampCaps(inW, caps.maxIn);
  // Чередуем сглаживание ширины и кламп к пределам: итог и плавный, и валидный.
  for (let pass = 0; pass < 2; pass++) {
    outW = smoothRing(outW, 2);
    inW = smoothRing(inW, 2);
    clampCaps(outW, caps.maxOut);
    clampCaps(inW, caps.maxIn);
  }

  const model: WidthModel = { center, outNormal, outW, inW };
  for (let attempt = 0; attempt < 5; attempt++) {
    const { outer, inner } = rebuildEdges(model);
    if (edgesValid(outer, inner)) return { model, outer, inner };
    // Пробуем ещё ужать — глобально, но мягко.
    for (let i = 0; i < n; i++) {
      model.outW[i] = Math.max(HALF_MIN, model.outW[i] * 0.85);
      model.inW[i] = Math.max(HALF_MIN, model.inW[i] * 0.85);
    }
  }
  return { error: strings.centerline.selfOverlap };
}

/** Перестроить кромки модели (после правки outW/inW). */
export function rebuildEdges(m: WidthModel): { outer: Polyline; inner: Polyline } {
  return offsetEdges(m.center, m.outNormal, m.outW, m.inW);
}

/**
 * Индекс ближайшей вершины осевой к точке p и сторона (внешняя/внутренняя),
 * кромку которой тянут, если p попала в толеранс. Иначе null.
 */
export function pickEdge(
  m: WidthModel,
  p: Vec,
  tol: number,
): { edge: 'outer' | 'inner'; index: number } | null {
  const { outer, inner } = rebuildEdges(m);
  let best: { edge: 'outer' | 'inner'; index: number } | null = null;
  let bestD = tol;
  for (let i = 0; i < outer.length; i++) {
    const dO = dist(p, outer[i]);
    if (dO < bestD) {
      bestD = dO;
      best = { edge: 'outer', index: i };
    }
    const dI = dist(p, inner[i]);
    if (dI < bestD) {
      bestD = dI;
      best = { edge: 'inner', index: i };
    }
  }
  return best;
}

/**
 * Применить перетаскивание: сдвинуть кромку `edge` в вершине `index` к точке p
 * (проекция на нормаль), с плавным затуханием на соседей. Тянемая точка следует
 * за пальцем целиком (без пер-вершинного клампа, из-за которого она «застревала»,
 * а по бокам ехало полотно). Если полное смещение сделало бы кромку невалидной
 * (налезла бы на другую часть трассы или ушла за поле) — подбираем бисекцией
 * максимально далёкое валидное положение, и кромка плавно «упирается». Модель
 * меняется только на валидное состояние. Возвращает true, если что-то сдвинулось.
 */
export function applyEdgeDrag(
  m: WidthModel,
  edge: 'outer' | 'inner',
  index: number,
  p: Vec,
): boolean {
  const n = m.center.length;
  const nrm = edge === 'outer' ? m.outNormal[index] : scale(m.outNormal[index], -1);
  const base = edge === 'outer' ? m.outW : m.inW;
  const cur = base[index];
  // Желаемое смещение тянемой вершины: проекция пальца на нормаль (с полом).
  const desired = Math.max(HALF_MIN, dot(sub(p, m.center[index]), nrm));
  const R = Math.max(6, Math.round(n / 10)); // окно затухания на соседей

  // Массив смещений при доле alpha пути от текущего положения к desired.
  const build = (alpha: number): number[] => {
    const target = cur + (desired - cur) * alpha;
    const next = base.slice();
    for (let k = -R; k <= R; k++) {
      const i = (index + k + n) % n;
      const wgt = 0.5 * (1 + Math.cos((Math.PI * k) / (R + 1))); // 1 в центре → 0 к краям
      next[i] = Math.max(HALF_MIN, base[i] + (target - base[i]) * wgt);
    }
    return next;
  };
  const tryAlpha = (alpha: number): number[] | null => {
    const next = build(alpha);
    const trial: WidthModel = {
      center: m.center,
      outNormal: m.outNormal,
      outW: edge === 'outer' ? next : m.outW,
      inW: edge === 'inner' ? next : m.inW,
    };
    const { outer, inner } = rebuildEdges(trial);
    return edgesValid(outer, inner) ? next : null;
  };

  // Сначала пробуем дойти до пальца целиком; если нельзя — ищем предел бисекцией.
  let best = tryAlpha(1);
  if (!best) {
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 6; it++) {
      const mid = (lo + hi) / 2;
      const res = tryAlpha(mid);
      if (res) {
        best = res;
        lo = mid;
      } else {
        hi = mid;
      }
    }
  }
  if (!best) return false;
  if (edge === 'outer') m.outW = best;
  else m.inW = best;
  return true;
}
