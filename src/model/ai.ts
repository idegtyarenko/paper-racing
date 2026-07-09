// ИИ-соперник: навигация по трассе и выбор хода. Чистая логика без DOM.
//
// Навигация — поле расстояний до финиша (BFS по узлам дороги track.inside,
// 8-связность): dist(клетка) = шагов при скорости 1 до следующего пересечения
// финишной линии вперёд. Линия финиша в BFS — «стенка» (рёбра сквозь неё не
// проходят), кроме финального прыжка из клеток-сидов: так клетки сразу за
// линией получают ≈длину круга «в обход», и болиду всегда выгодно ехать вперёд.
//
// Выбор хода — поиск с ограниченной глубиной по собственным ходам болида
// (соперники учитываются только на первом слое, через реальные blocked из
// candidates(): к более глубоким слоям они всё равно сдвинутся). Лист поиска
// оценивается потенциалом phi = dist + (осталось пересечений − 1)·круг, плюс
// классический инвариант безопасности «успею ли затормозить» (canStop) — он
// не даёт разгоняться туда, откуда уже не вписаться в поворот.

import { Vec, dist, segSegIntersection } from '../geometry';
import { Track, key, unkey, sideOfFinish } from './track';
import {
  GameState,
  Candidate,
  MoveOutcome,
  WIN_CROSSINGS,
  computeOutcome,
  offRoadDepth,
} from './game';
import { candidates } from './turns';
import { OFFROAD_FORGIVE } from '../config';

export type Difficulty = 'easy' | 'medium' | 'hard';

/** Поле расстояний до финиша по узлам дороги. */
export interface NavField {
  /** key(x,y) → шагов (при скорости 1) до следующего пересечения финиша вперёд. */
  dist: Map<number, number>;
  /** ≈ длина круга в шагах: max конечного dist + 1. Слагаемое за недоеханный круг. */
  lap: number;
  /** Трасса поля — для стороны финиша в navAt (окно не должно глядеть через линию). */
  track: Track;
}

/** Ручки силы бота — см. таблицу в DIFFICULTY. */
interface DifficultyParams {
  /** Глубина поиска в ходах, включая первый (1 — жадный выбор). */
  depth: number;
  /** Лимит рекурсии canStop; на срезе — оптимистичное «успею». Меньше — бот
   *  проверяет торможение на меньше ходов вперёд и вылетает в поворотах. */
  stopCap: number;
  /** Мягкий потолок скорости: превышение штрафуется, но не запрещено. */
  maxSpeed: number;
  /** Вероятность взять случайный из почти-лучших ходов (разнообразие без дёрганья). */
  epsilon: number;
}

const DIFFICULTY: Record<Difficulty, DifficultyParams> = {
  easy: { depth: 1, stopCap: 2, maxSpeed: 4, epsilon: 0.3 },
  medium: { depth: 2, stopCap: 6, maxSpeed: 6, epsilon: 0.1 },
  // Глубина 3, не 4: на больших рисованных трассах ход глубины 4 стоил ~200 мс
  // (computeOutcome дорог), а прирост силы против глубины 3 незаметен.
  hard: { depth: 3, stopCap: 12, maxSpeed: Infinity, epsilon: 0 },
};

// ── Константы оценки (алгоритмические, не игровые — потому здесь, не в config) ──
/** Средняя крейсерская скорость: перевод потерянных ходов в «клетки пути». */
const AVG_SPEED = 4;
/** Сколько ходов стоит разгон с нуля после возврата из гравия. */
const RESTART_TURNS = 3;
/** Штраф листа, из которого нельзя гарантированно затормозить (≈ будущая авария). */
const UNSAFE_PENALTY = 30;
/** Штраф за клетку превышения мягкого потолка скорости. */
const OVERSPEED_PENALTY = 8;
/** Финишный ход вне конкуренции: бонус много больше любых расстояний. */
const FINISH_BONUS = 1e6;
/** Цена хода задержки финиша: финишировать раньше важнее любой глубины заезда
 *  (глубина — лишь тай-брейк решающего круга при равном числе ходов). */
const FINISH_DELAY_COST = 1e3;
/** Ходы в этой полосе от лучшего считаются «почти лучшими» (для epsilon-выбора). */
const EPS_MARGIN = 3;

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
      // Клетка по ту сторону финишной линии не годится: её расстояние учитывает
      // другое число оставшихся пересечений (иначе потенциал у линии схлопывается,
      // и бот «прилипает» к ней вместо честного круга).
      if (crossDir(field.track, p, c) !== 0) continue;
      best = Math.min(best, v + dist(p, c));
    }
  }
  return best === Infinity ? field.lap : best;
}

/** Все 9 векторов ускорения одного хода. */
const ACCELS: Vec[] = [];
for (let ay = -1; ay <= 1; ay++) {
  for (let ax = -1; ax <= 1; ax++) ACCELS.push({ x: ax, y: ay });
}

/**
 * Выбрать ход бота из candidates(state). Возвращает не-blocked кандидата;
 * null — пат (все 9 заняты соперниками), вызывающий пасует (coastMove).
 * Соперники дальше первого слоя не учитываются — к тому времени они сдвинутся.
 */
export function chooseMove(
  state: GameState,
  nav: NavField,
  difficulty: Difficulty,
  rng: () => number = Math.random,
): Candidate | null {
  const P = DIFFICULTY[difficulty];
  const { track, rules } = state;
  const me = state.players[state.current];
  const left0 = WIN_CROSSINGS - me.crossings;

  // Кэши на один вызов: computeOutcome дорог (густой семплинг × pointInPolygon),
  // а поиск многократно приходит в одни и те же (from, target).
  const outcomeMemo = new Map<string, MoveOutcome>();
  const searchMemo = new Map<string, number>();
  const stopMemo = new Map<string, boolean>();

  const outcome = (from: Vec, to: Vec): MoveOutcome => {
    const k = `${from.x},${from.y}:${to.x},${to.y}`;
    let o = outcomeMemo.get(k);
    if (!o) {
      o = computeOutcome(track, rules, from, to);
      outcomeMemo.set(k, o);
    }
    return o;
  };

  const phi = (p: Vec, left: number): number => navAt(nav, p) + (left - 1) * nav.lap;

  /** Успею ли из (pos, vel) остановиться, не вылетев. Кап рекурсии — ручка
   *  сложности: на срезе оптимистично считаем, что успею. */
  const canStop = (pos: Vec, vel: Vec, cap: number): boolean => {
    if (vel.x === 0 && vel.y === 0) return true;
    if (cap <= 0) return true;
    const k = `${pos.x},${pos.y},${vel.x},${vel.y},${cap}`;
    const hit = stopMemo.get(k);
    if (hit !== undefined) return hit;
    // Сначала пробуем сильнее тормозить: обычно быстро находит цепочку до нуля.
    const byBraking = ACCELS.slice().sort(
      (a, b) =>
        Math.hypot(vel.x + a.x, vel.y + a.y) - Math.hypot(vel.x + b.x, vel.y + b.y),
    );
    let ok = false;
    for (const a of byBraking) {
      const o = outcome(pos, { x: pos.x + vel.x + a.x, y: pos.y + vel.y + a.y });
      if (!o.crash && canStop(o.end, o.vel, cap - 1)) {
        ok = true;
        break;
      }
    }
    stopMemo.set(k, ok);
    return ok;
  };

  /**
   * Ценность исхода хода (меньше — лучше): оставшийся путь в клетках после
   * ещё depth ходов поиска. Авария и финиш — терминальны.
   */
  const valueOf = (o: MoveOutcome, leftBefore: number, depth: number): number => {
    const left = leftBefore - o.crossingDelta;
    // Финиш: вне конкуренции. Раньше — лучше (задержка на ход стоит дороже любой
    // глубины), при равном числе ходов глубже за линию — лучше (тай-брейк
    // решающего круга). Авария после пересечения финишу не мешает.
    if (left <= 0) {
      const delay = P.depth - 1 - depth;
      return -FINISH_BONUS + delay * FINISH_DELAY_COST - sideOfFinish(track, o.end);
    }
    // Авария: простой в гравии + разгон с нуля, пересчитанные в клетки пути.
    if (o.crash) {
      return phi(o.end, left) + (o.skipTurns + RESTART_TURNS) * AVG_SPEED;
    }
    if (depth <= 0) {
      return phi(o.end, left) + (canStop(o.end, o.vel, P.stopCap) ? 0 : UNSAFE_PENALTY);
    }
    const k = `${o.end.x},${o.end.y},${o.vel.x},${o.vel.y},${left},${depth}`;
    const hit = searchMemo.get(k);
    if (hit !== undefined) return hit;
    let best = Infinity;
    for (const a of ACCELS) {
      const target = { x: o.end.x + o.vel.x + a.x, y: o.end.y + o.vel.y + a.y };
      best = Math.min(best, valueOf(outcome(o.end, target), left, depth - 1));
    }
    searchMemo.set(k, best);
    return best;
  };

  const open = candidates(state).filter((c) => !c.blocked);
  if (open.length === 0) return null;

  const scored = open.map((c) => {
    let score = valueOf(outcome(me.pos, c.target), left0, P.depth - 1);
    const speed = dist(me.pos, c.target);
    if (speed > P.maxSpeed) score += (speed - P.maxSpeed) * OVERSPEED_PENALTY;
    return { c, score };
  });

  let best = scored[0];
  for (const s of scored) if (s.score < best.score) best = s;
  const near = scored.filter((s) => s.score <= best.score + EPS_MARGIN);
  if (near.length > 1 && rng() < P.epsilon) {
    return near[Math.min(near.length - 1, Math.floor(rng() * near.length))].c;
  }
  return best.c;
}

/** Экспорт для тестов: параметры сложности (глубина/потолок скорости и т.д.). */
export const DIFFICULTY_PARAMS: Readonly<Record<Difficulty, DifficultyParams>> =
  DIFFICULTY;
