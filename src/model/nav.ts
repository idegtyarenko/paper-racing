// Навигационное поле трассы: расстояния до финиша по узлам дороги (BFS,
// 8-связность). Изначально строилось для ИИ (см. ai.ts), но используется и
// табло текущих мест (standings.ts) как оценка «сколько ещё ехать до финиша»,
// поэтому вынесено в отдельный модуль. Чистая логика без DOM.
//
// dist(клетка) = шагов при скорости 1 до следующего пересечения финишной линии
// вперёд. Линия финиша в BFS — «стенка» (рёбра сквозь неё не проходят), кроме
// финального прыжка из клеток-сидов: так клетки сразу за линией получают
// ≈длину круга «в обход», и болиду всегда выгодно ехать вперёд.

import { Vec, dist, lerp, segSegIntersection } from '../geometry';
import { Track, key, unkey, sideOfFinish } from './track';
import { offRoadDepth } from './game';
import { OFFROAD_FORGIVE } from '../config';

/** Поле расстояний до финиша по узлам дороги. */
export interface NavField {
  /** key(x,y) → шагов (при скорости 1) до следующего пересечения финиша вперёд. */
  dist: Map<number, number>;
  /** ≈ длина круга в шагах: max конечного dist + 1. Слагаемое за недоеханный круг. */
  lap: number;
  /** Трасса поля — для стороны финиша в navAt (окно не должно глядеть через линию). */
  track: Track;
}

/**
 * Направление пересечения финиша ребром u→v: +1 вперёд, −1 назад, 0 нет.
 * Та же семантика, что у computeOutcome: точка ровно на линии считается
 * стороной «впереди», чтобы не засчитать одно пересечение дважды.
 */
function crossDir(track: Track, u: Vec, v: Vec): number {
  if (!segSegIntersection(u, v, track.finish.a, track.finish.b)) return 0;
  const su = sideOfFinish(track, u);
  const sv = sideOfFinish(track, v);
  if (su < 0 && sv >= 0) return 1;
  if (su >= 0 && sv < 0) return -1;
  return 0;
}

/**
 * Ребро проходимо: его середина не глубже допуска за кромкой. Отсекает
 * диагонали и рёбра, «туннелирующие» узкую травяную перегородку между
 * двумя проходами трассы (иначе поле повело бы ботов в невозможный срез).
 */
function edgeOk(track: Track, u: Vec, v: Vec): boolean {
  return (
    offRoadDepth(track, { x: (u.x + v.x) / 2, y: (u.y + v.y) / 2 }) <= OFFROAD_FORGIVE
  );
}

/** Построить поле расстояний до финиша. Считается один раз на гонку. */
export function buildNavField(track: Track): NavField {
  const d = new Map<number, number>();
  const queue: Vec[] = [];

  // Сиды: клетки за линией, из которых один шаг пересекает финиш вперёд.
  track.inside.forEach((k) => {
    const u = unkey(k);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const v = { x: u.x + dx, y: u.y + dy };
        if (!track.inside.has(key(v.x, v.y))) continue;
        if (crossDir(track, u, v) === 1 && edgeOk(track, u, v)) {
          d.set(k, 1);
          queue.push(u);
          return;
        }
      }
    }
  });

  // BFS назад по рёбрам, не пересекающим финиш: клетки «впереди» линии
  // получают расстояние длинным путём в обход круга.
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    const du = d.get(key(u.x, u.y))!;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const w = { x: u.x + dx, y: u.y + dy };
        const wk = key(w.x, w.y);
        if (d.has(wk) || !track.inside.has(wk)) continue;
        if (crossDir(track, w, u) !== 0 || !edgeOk(track, w, u)) continue;
        d.set(wk, du + 1);
        queue.push(w);
      }
    }
  }

  let lap = 0;
  d.forEach((v) => {
    lap = Math.max(lap, v);
  });
  return { dist: d, lap: lap + 1, track };
}

/**
 * Отрезок a→b целиком на дороге (в пределах допуска). Тот же критерий, что у
 * движка в scanMove: середины семплов не глубже OFFROAD_FORGIVE за кромкой. Шаг
 * ~0.5 клетки ловит тонкую травяную перегородку (≥ ~1 клетка) между проходами.
 */
function segOnRoad(track: Track, a: Vec, b: Vec): boolean {
  const steps = Math.max(1, Math.ceil(dist(a, b) / 0.5));
  for (let i = 1; i < steps; i++) {
    if (offRoadDepth(track, lerp(a, b, i / steps)) > OFFROAD_FORGIVE) return false;
  }
  return true;
}

/**
 * Расстояние до финиша для произвольной точки — не обязательно узла дороги
 * (точка аварии дробная; легальный ход может закончиться в полосе допуска или
 * ближе WALL_CLEARANCE к стенке, где узлов в inside нет). Берём минимум
 * dist + евклидов добор по клеткам окна ±3; совсем вне окна (глухой гравий) —
 * консервативно длина круга.
 */
export function navAt(field: NavField, p: Vec): number {
  const cx = Math.round(p.x);
  const cy = Math.round(p.y);
  let best = Infinity;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const c = { x: cx + dx, y: cy + dy };
      const v = field.dist.get(key(c.x, c.y));
      if (v === undefined) continue;
      const est = v + dist(p, c);
      if (est >= best) continue;
      // Клетка по ту сторону финишной линии не годится: её расстояние учитывает
      // другое число оставшихся пересечений (иначе потенциал у линии схлопывается,
      // и бот «прилипает» к ней вместо честного круга).
      if (crossDir(field.track, p, c) !== 0) continue;
      // Луч p→c не должен резать стену: иначе поле «протекает» на соседний
      // проход трассы через тонкую перегородку, и бот едет прямо в неё. Проверяем
      // лениво — только кандидатов, реально тянущих минимум вниз.
      if (!segOnRoad(field.track, p, c)) continue;
      best = est;
    }
  }
  return best === Infinity ? field.lap : best;
}
