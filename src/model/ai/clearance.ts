// Растр знакового зазора до кромок трассы — дешёвая проверка «аварийный ли ход»
// для планировщика ИИ (planner.ts). Чистая логика без DOM.
//
// Зачем: точный computeOutcome (game.ts) семплит отрезок густо и на каждой точке
// зовёт pointInPolygon по сотням вершин — дорого. Планировщику A* нужен лишь факт
// «пересёк ли ход стенку», а не точка аварии. Предпосчитываем поле зазора один раз
// на гонку (как buildNavField) и потом выбираем его билинейно за O(1) на семпл.
//
// Зазор со знаком: на дороге — +расстояние до ближайшей кромки, за кромкой —
// −(глубина за кромкой). Ход — авария, если вдоль отрезка зазор где-то опускается
// ниже −OFFROAD_FORGIVE (та же семантика, что scanMove в game.ts). Выборка чуть
// консервативна (−0.5·шаг запаса), чтобы «запланированно безопасный» ход не вылетал
// в реальном движке из-за огрубления растра.

import { Vec, distPointToPolyline } from '../../geometry';
import { Track, onRoad } from '../track';
import { OFFROAD_FORGIVE } from '../../config';

/** Шаг растра в клетках. 0.2 ≪ типичной ширины трассы (2..6) — тонкие перегородки
 *  и кромки ловятся, память умеренная (несколько сотен КБ на гонку). */
const CELL = 0.2;
/** Шаг семплинга отрезка хода при проверке (в клетках). Как у движка (scanMove),
 *  чтобы не «перепрыгнуть» мелкий срез угла между семплами. */
const STEP = 0.05;
/** Запас консервативности сверх допуска, в клетках. Билинейная выборка у выпуклого
 *  угла стенки ЗАВЫШАЕТ зазор (истинный минимум — в самой вершине, между узлами
 *  решётки) на ~CELL/2. Требуем зазор с этим запасом, иначе планировщик поверит в
 *  «быстрый безопасный план» у апекса, которого в точном движке нет, и через пару
 *  ходов влетит в скоростную ловушку. */
const MARGIN = CELL;

export interface Clearance {
  minX: number;
  minY: number;
  cols: number;
  rows: number;
  /** Знаковый зазор в узлах решётки (row-major): + на дороге, − за кромкой. */
  data: Float32Array;
}

/** Знаковый зазор точки: + на дороге (до ближайшей кромки), − за кромкой (глубина). */
function signedClearance(track: Track, p: Vec): number {
  const d = Math.min(
    distPointToPolyline(p, track.outer),
    distPointToPolyline(p, track.inner),
  );
  return onRoad(p, track.outer, track.inner) ? d : -d;
}

/** Построить растр зазора по bbox внешнего контура (+поля). Раз на гонку. */
export function buildClearance(track: Track): Clearance {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of track.outer) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  // Поле в 1 клетку: болид может законно оказаться в полосе допуска у самой кромки.
  minX -= 1;
  minY -= 1;
  maxX += 1;
  maxY += 1;
  const cols = Math.ceil((maxX - minX) / CELL) + 1;
  const rows = Math.ceil((maxY - minY) / CELL) + 1;
  const data = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      data[r * cols + c] = signedClearance(track, {
        x: minX + c * CELL,
        y: minY + r * CELL,
      });
    }
  }
  return { minX, minY, cols, rows, data };
}

/** Билинейная выборка зазора в произвольной точке. Вне решётки — глубоко за краем. */
function sample(f: Clearance, x: number, y: number): number {
  const fx = (x - f.minX) / CELL;
  const fy = (y - f.minY) / CELL;
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fy);
  if (c0 < 0 || r0 < 0 || c0 + 1 >= f.cols || r0 + 1 >= f.rows) return -1e3;
  const tx = fx - c0;
  const ty = fy - r0;
  const i = r0 * f.cols + c0;
  const a = f.data[i];
  const b = f.data[i + 1];
  const cc = f.data[i + f.cols];
  const d = f.data[i + f.cols + 1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + cc * (1 - tx) * ty + d * tx * ty;
}

/**
 * Проходим ли отрезок хода a→b, ни разу не зайдя за кромку глубже допуска.
 * Консервативно (запас в полшага растра): бордерлайн считаем аварией, чтобы
 * запланированный «безопасный» ход не вылетал в точном движке.
 */
export function segClear(f: Clearance, a: Vec, b: Vec): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(len / STEP));
  const floor = -OFFROAD_FORGIVE + MARGIN; // допуск движка + запас консервативности
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (sample(f, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) < floor) return false;
  }
  return true;
}
