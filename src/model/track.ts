// Модель трассы: обработка нарисованных штрихов, валидация, финализация.

import {
  Vec,
  Polyline,
  add,
  sub,
  dot,
  dist,
  lerp,
  scale,
  normalize,
  pointInPolygon,
  distPointToPolyline,
  distPointToSegment,
  segmentPolylineIntersections,
  resampleClosed,
  chaikinClosed,
  trimSeamOverlap,
} from '../geometry';
import { strings } from '../i18n';
import {
  WORLD_SIZE,
  WALL_CLEARANCE,
  MAX_START_POINTS,
  MIN_ROAD_CELLS,
  START_ROW_MAX,
  START_REGION_DEPTH,
  START_SEED_TOL,
} from '../config';

export interface FinishLine {
  a: Vec;
  b: Vec;
}

export interface Track {
  outer: Polyline;
  inner: Polyline;
  finish: FinishLine;
  /** Единичная нормаль финишной линии в направлении гонки. */
  forward: Vec;
  /** Узлы сетки, лежащие на дороге (ключи — см. key()). */
  inside: Set<number>;
  /** Стартовые узлы, строго позади финишной линии (ближайшие к ней — первыми). */
  startPoints: Vec[];
}

const KEY_OFFSET = 128;

export const key = (x: number, y: number): number =>
  (x + KEY_OFFSET) * 4096 + (y + KEY_OFFSET);

export const unkey = (k: number): Vec => ({
  x: Math.floor(k / 4096) - KEY_OFFSET,
  y: (k % 4096) - KEY_OFFSET,
});

export type StrokeResult = { poly: Polyline } | { error: string };

/** Замыкание, ресемплинг и сглаживание сырого freehand-штриха. */
export function processStroke(raw: Vec[]): StrokeResult {
  if (raw.length < 8) {
    return { error: strings.track.strokeShort };
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of raw) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (diag < 4) {
    return { error: strings.track.strokeShort };
  }
  if (dist(raw[0], raw[raw.length - 1]) > 0.25 * diag) {
    return { error: strings.track.notClosed };
  }
  const maxTrim = Math.max(2, 0.12 * diag); // порог «мелкого» нахлёста концов
  const closed = trimSeamOverlap(raw, maxTrim);
  let poly = resampleClosed(closed, 0.5);
  poly = chaikinClosed(poly, 2);
  poly = resampleClosed(poly, 0.5);
  return { poly };
}

/** Точка (не обязательно узел) лежит на дороге между краями. */
export function onRoad(p: Vec, outer: Polyline, inner: Polyline): boolean {
  return pointInPolygon(p, outer) && !pointInPolygon(p, inner);
}

function isRoadLatticePoint(p: Vec, outer: Polyline, inner: Polyline): boolean {
  return (
    onRoad(p, outer, inner) &&
    distPointToPolyline(p, outer) > WALL_CLEARANCE &&
    distPointToPolyline(p, inner) > WALL_CLEARANCE
  );
}

/**
 * Строит финишную линию по протяжке пользователя: линия продлевается в обе
 * стороны, из пересечений с краями берётся участок дороги, содержащий
 * середину протяжки. Концы выносятся на 0.25 клетки за стенки, чтобы закрыть
 * численные щели. Протяжку не обязательно вести точно от стенки до стенки —
 * достаточно задать направление поперёк дороги.
 */
export type ClipFinishResult = { finish: FinishLine } | { error: 'no-cross' | 'narrow' };

export function clipFinishLine(
  a: Vec,
  b: Vec,
  outer: Polyline,
  inner: Polyline,
): ClipFinishResult {
  const d = normalize(sub(b, a));
  if (d.x === 0 && d.y === 0) return { error: 'no-cross' };
  const EXT = 200;
  const A = sub(a, scale(d, EXT));
  const B = add(b, scale(d, EXT));
  const hits = [
    ...segmentPolylineIntersections(A, B, outer),
    ...segmentPolylineIntersections(A, B, inner),
  ].sort((x, y) => x.t - y.t);
  const mid = lerp(a, b, 0.5);
  const tMid = dot(sub(mid, A), d) / dist(A, B);
  for (let i = 0; i + 1 < hits.length; i++) {
    if (hits[i].t <= tMid && tMid <= hits[i + 1].t) {
      const p1 = hits[i].point;
      const p2 = hits[i + 1].point;
      // Середина отрезка между соседними пересечениями вне дороги —
      // линия проходит по «пробелу» (мимо дороги), а не поперёк неё.
      if (!onRoad(lerp(p1, p2, 0.5), outer, inner)) return { error: 'no-cross' };
      // Дорога пересечена правильно, но слишком узка в этом месте.
      if (dist(p1, p2) < 1) return { error: 'narrow' };
      return { finish: { a: sub(p1, scale(d, 0.25)), b: add(p2, scale(d, 0.25)) } };
    }
  }
  return { error: 'no-cross' };
}

/** Знаковое расстояние точки до финишной линии вдоль направления гонки. */
export function sideOfFinish(track: Pick<Track, 'finish' | 'forward'>, p: Vec): number {
  return dot(sub(p, track.finish.a), track.forward);
}

/** Стартовый кандидат: узел позади финиша плюс его коридорная глубина (шаги BFS
 *  назад от линии, считаются в finalizeTrack). */
export interface StartCandidate {
  p: Vec;
  corridor: number;
}

/**
 * Стартовая решётка: из узлов позади финиша выбирает до MAX_START_POINTS точек,
 * рядами вдоль коридора от линии назад. «Ряд» — один слой коридорной глубины (шаги
 * BFS от линии): на прямой это колонка узлов позади линии, на повороте — дуга,
 * повторяющая изгиб дороги. Ряд наполняется от центра трассы к бокам до START_ROW_MAX
 * болидов; не влезли — уходят в следующий (более глубокий) слой. Смысл — минимум
 * глубины при центральном старте: никто не стоит сбоку у стенки (боковой старт то
 * выгоден, то нет — этот шум убираем), а лишняя глубина появляется, лишь когда
 * болидов больше, чем помещается в центральную полосу.
 *
 * Кандидаты берутся строго по возрастанию коридорной глубины, поэтому далёкий узел
 * на дальнем витке (большая глубина) не может быть выбран, пока есть ближние: старт
 * всегда плотный пучок вплотную за линией, даже когда дорога уходит в излом сразу за
 * финишем. Поперечное центрирование — по оси финишной линии latUnit (на малых
 * глубинах, где реально стоят болиды, она надёжна). Возвращает точки по возрастанию
 * глубины (первый — поул); при меньшем числе игроков newGame берёт передние слоты
 * (первый ряд на линии), так что 2–3 болида стартуют без глубины вовсе.
 */
export function layoutStartGrid(
  finish: FinishLine,
  forward: Vec,
  behind: StartCandidate[],
): Vec[] {
  const M = lerp(finish.a, finish.b, 0.5);
  const latUnit = normalize(sub(finish.b, finish.a)); // поперечная ось (вдоль линии)
  const cand = behind.map((c) => ({
    p: c.p,
    corridor: c.corridor,
    lat: dot(sub(c.p, M), latUnit),
  }));
  // Поул-первым, центр-первым: сначала ближе к линии по коридору, затем ближе к центру.
  cand.sort(
    (a, b) =>
      a.corridor - b.corridor ||
      Math.abs(a.lat) - Math.abs(b.lat) ||
      a.p.y - b.p.y ||
      a.p.x - b.p.x,
  );

  const picked = new Set<(typeof cand)[number]>();
  const perRow = new Map<number, number>();
  // Проход 1: до START_ROW_MAX центральных узлов на слой коридора, мелкие слои раньше;
  // переполненный ряд «перетекает» в следующий (более глубокий) слой.
  for (const c of cand) {
    if (picked.size >= MAX_START_POINTS) break;
    const n = perRow.get(c.corridor) ?? 0;
    if (n >= START_ROW_MAX) continue;
    perRow.set(c.corridor, n + 1);
    picked.add(c);
  }
  // Проход 2 (страховка; только вырожденные однослойные полоски, где глубины не хватает
  // на MAX_START_POINTS рядами ≤ START_ROW_MAX): добираем оставшиеся в том же порядке.
  if (picked.size < MAX_START_POINTS) {
    for (const c of cand) {
      if (picked.size >= MAX_START_POINTS) break;
      picked.add(c);
    }
  }

  // Порядок «спереди назад»: поул (index 0) — ближайший к линии по коридору, центр ряда
  // первым. При меньшем числе игроков newGame возьмёт передние n, перестановка — случайно.
  return [...picked]
    .sort(
      (a, b) =>
        a.corridor - b.corridor ||
        Math.abs(a.lat) - Math.abs(b.lat) ||
        a.p.y - b.p.y ||
        a.p.x - b.p.x,
    )
    .map((c) => c.p);
}

export type FinalizeResult = { track: Track } | { error: string };

export function finalizeTrack(
  outer: Polyline,
  inner: Polyline,
  finish: FinishLine,
  forward: Vec,
): FinalizeResult {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of outer) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const x0 = Math.max(0, Math.floor(minX));
  const x1 = Math.min(WORLD_SIZE, Math.ceil(maxX));
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(WORLD_SIZE, Math.ceil(maxY));

  const inside = new Set<number>();
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (isRoadLatticePoint({ x, y }, outer, inner)) inside.add(key(x, y));
    }
  }
  if (inside.size < MIN_ROAD_CELLS) {
    return { error: strings.track.tooNarrow };
  }

  // Стартовые кандидаты — не вся полуплоскость «позади финиша» (на змейке она
  // захватывает далёкие сегменты трассы, и запасное заполнение решётки могло усадить
  // болид посреди круга), а связный коридор сразу за линией: BFS назад от узлов,
  // касающихся линии сзади, только по «задним» узлам дороги, с ограничением глубины.
  const isBehind = (p: Vec): boolean => sideOfFinish({ finish, forward }, p) < -1e-9;
  const behind: StartCandidate[] = [];
  const depth = new Map<number, number>();
  const queue: Vec[] = [];
  const NB8 = [
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, -1],
    [0, 1],
    [1, -1],
    [1, 0],
    [1, 1],
  ];
  // Затравка: задние узлы дороги вплотную к ОТРЕЗКУ финиша (не к бесконечной прямой —
  // она рассекает и другие сегменты змейки; привязка к отрезку не даёт зоне прорасти
  // из далёкого пересечения).
  inside.forEach((k) => {
    const p = unkey(k);
    if (!isBehind(p)) return;
    if (distPointToSegment(p, finish.a, finish.b) <= START_SEED_TOL) {
      depth.set(k, 0);
      queue.push(p);
      behind.push({ p, corridor: 0 });
    }
  });
  // Волна вглубь коридора по задним узлам дороги; узлы на самой границе глубины
  // сохраняем, но дальше от них не растём.
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head];
    const d = depth.get(key(p.x, p.y))!;
    if (d >= START_REGION_DEPTH) continue;
    for (const [dx, dy] of NB8) {
      const q = { x: p.x + dx, y: p.y + dy };
      const qk = key(q.x, q.y);
      if (depth.has(qk) || !inside.has(qk) || !isBehind(q)) continue;
      depth.set(qk, d + 1);
      queue.push(q);
      behind.push({ p: q, corridor: d + 1 });
    }
  }
  if (behind.length < 2) {
    return { error: strings.track.noStartRoom };
  }
  return {
    track: {
      outer,
      inner,
      finish,
      forward,
      inside,
      startPoints: layoutStartGrid(finish, forward, behind),
    },
  };
}
