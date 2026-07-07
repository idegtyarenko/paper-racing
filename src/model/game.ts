// Игровой движок: состояние гонки, кандидаты хода, аварии, финиш, победа.
// Чистая логика без DOM.

import {
  Vec,
  dist,
  lerp,
  distPointToPolyline,
  pointOnSegment,
  segSegIntersection,
} from '../geometry';
import { Track, key, unkey, sideOfFinish, onRoad } from './track';
import { strings } from '../strings';
import {
  MIN_PLAYERS,
  WIN_CROSSINGS,
  CRASH_SKIP_TURNS,
  CRASH_PENALTY_MAX,
  OFFROAD_FORGIVE,
  CRASH_SAMPLE_STEP,
} from '../config';

export interface TrailSeg {
  from: Vec;
  to: Vec;
  /** true — «телепорт» на точку возврата после аварии (рисуется пунктиром). */
  jump: boolean;
}

export interface Player {
  name: string;
  color: string;
  pos: Vec;
  vel: Vec;
  trail: TrailSeg[];
  crashes: Vec[];
  skipTurns: number;
  /** Знаковый счётчик пересечений финишной линии: вперёд +1, назад −1. */
  crossings: number;
  finishOvershoot: number | null;
}

// Число пересечений финиша для победы (см. WIN_CROSSINGS в config) — реэкспорт.
export { WIN_CROSSINGS };

/**
 * Настройки правил заезда. В онлайне их задаёт хост, и они едут вместе со стейтом
 * (rules — часть GameState, а сериализуется весь стейт кроме track), поэтому у всех
 * игроков применяются одни и те же правила.
 */
export interface Rules {
  /** Как считать штраф за вылет: 'dynamic' — по скорости, 'static' — фиксированный. */
  penalty: 'dynamic' | 'static';
  /** Размер штрафа в ходах при статическом штрафе. */
  staticTurns: number;
  /** Показатель степени («строгость») формулы динамического штрафа. */
  dynamicExponent: number;
  /** Порядок ходов в онлайне. Пока всегда 'sequential' (переключатель заблокирован). */
  turnMode: 'sequential' | 'simultaneous';
}

/** Правила по умолчанию: динамический штраф со стандартной (линейной) строгостью. */
export const DEFAULT_RULES: Rules = {
  penalty: 'dynamic',
  staticTurns: CRASH_SKIP_TURNS,
  dynamicExponent: 1,
  turnMode: 'sequential',
};

/**
 * Штраф за аварию в ходах. Статический — фиксированное число. Динамический —
 * степенная функция скорости хода (длины вектора перемещения):
 * round(speed ^ строгость), зажатая в [1, CRASH_PENALTY_MAX]. При строгости 1
 * это линейно (скорость 1→1 ход, 2→2, 3→3), выше — круче для быстрых вылетов.
 */
export function crashPenalty(rules: Rules, speed: number): number {
  if (rules.penalty === 'static') return rules.staticTurns;
  const t = speed ** rules.dynamicExponent;
  return Math.min(CRASH_PENALTY_MAX, Math.max(1, Math.round(t)));
}

export interface GameState {
  track: Track;
  players: Player[];
  /** Правила заезда (штраф за вылет, порядок ходов). */
  rules: Rules;
  current: number;
  phase: 'race' | 'over';
  winner: number | 'draw' | null;
  /**
   * Сколько ходов осталось доиграть в решающем круге. Пока никто не финишировал —
   * null. Как только кто-то пересёк финиш, остальные игроки этого же круга
   * доигрывают свои ходы (это число), после чего победитель определяется по
   * глубине заезда за линию среди всех финишировавших в решающем круге.
   */
  finalTurnsLeft: number | null;
}

/** Цвета и имена болидов по индексу игрока (до шести участников). */
const COLORS = ['#c62828', '#1565c0', '#2e7d32', '#ef6c00', '#6a1b9a', '#0097a7'];

/** Имена болидов по цвету — строго в порядке COLORS. */
const NAMES = strings.players.names;

export const MAX_PLAYERS = COLORS.length;
// Минимум участников (см. MIN_PLAYERS в config) — реэкспорт.
export { MIN_PLAYERS };

/** Цвет болида по индексу места — для рендера ростера лобби в онлайне. */
export function seatColor(i: number): string {
  return COLORS[i % COLORS.length];
}

export interface Candidate {
  target: Vec;
  crash: boolean;
  /** Точка занята соперником — ход запрещён. */
  blocked: boolean;
  /** Кандидат чистой инерции (ускорение 0,0). */
  inertial: boolean;
}

export function newGame(
  track: Track,
  playerCount = 2,
  rules: Rules = DEFAULT_RULES,
): GameState {
  const n = Math.max(
    MIN_PLAYERS,
    Math.min(MAX_PLAYERS, playerCount, track.startPoints.length),
  );
  const mk = (i: number): Player => ({
    name: NAMES[i],
    color: COLORS[i],
    pos: { ...track.startPoints[i] },
    vel: { x: 0, y: 0 },
    trail: [],
    crashes: [],
    skipTurns: 0,
    crossings: 0,
    finishOvershoot: null,
  });
  return {
    track,
    players: Array.from({ length: n }, (_, i) => mk(i)),
    rules,
    current: 0,
    phase: 'race',
    winner: null,
    finalTurnsLeft: null,
  };
}

/**
 * Глубокая копия стейта для confirm-first отправки хода: применяем ход к копии,
 * шлём её на сервер и лишь при успехе делаем её текущей — оригинал остаётся цел,
 * чтобы при ошибке выбор игрока не пропал. Всё, кроме track (неизменная трасса,
 * шарим по ссылке), — обычные JSON-данные, поэтому structuredClone безопасен.
 */
export function cloneState(g: GameState): GameState {
  const { track, ...rest } = g;
  return { ...structuredClone(rest), track };
}

/** Насколько глубоко точка зашла за край дороги: 0 на дороге, иначе — до ближайшей стенки. */
function offRoadDepth(track: Track, p: Vec): number {
  if (onRoad(p, track.outer, track.inner)) return 0;
  return Math.min(
    distPointToPolyline(p, track.outer),
    distPointToPolyline(p, track.inner),
  );
}

/** Результат прохода по отрезку хода: авария ли, и где именно случилась. */
interface MoveScan {
  crash: boolean;
  /** Параметр вдоль from→to в точке аварии (Infinity, если аварии нет). */
  tCrash: number;
  /** Точка аварии на кромке (null, если аварии нет). */
  crashAt: Vec | null;
}

/**
 * Единый проход по отрезку хода: и детект аварии, и её локализация одним
 * критерием (глубина за кромкой > OFFROAD_FORGIVE). Ход — авария, если где-то
 * вдоль отрезка он заходит за стенку глубже допуска: густой семплинг ловит и
 * заезды «насквозь» через газон, и глубокие срезы углов, но прощает касания
 * впритирку.
 *
 * Точку аварии находим бисекцией по изолинии допуска (глубина == OFFROAD_FORGIVE),
 * а не по самой кромке: если ход стартует уже в полосе допуска за стенкой и уходит
 * глубже по ту же сторону, отрезок кромку может вовсе не пересечь — тогда искать
 * «пересечение со стенкой» бессмысленно, а порог допуска всегда взят в вилку
 * (from — внутри допуска по инварианту, первый «плохой» семпл — за ним). Так
 * crashAt садится ≈на кромку одинаково, стартовал ход внутри трассы или в полосе
 * допуска — в этом и была асимметрия старой логики.
 *
 * Инвариант «from в пределах допуска»: старт — узел дороги (см. track.ts), обычный
 * ход кончается там, где scanMove не дал аварии (глубина конца ≤ допуска), аварийный
 * ход кончается на crashAt (тоже в допуске), а возврат после штрафа — на узле дороги
 * (nearestFreeInsidePoint).
 */
function scanMove(track: Track, from: Vec, to: Vec): MoveScan {
  const steps = Math.max(2, Math.ceil(dist(from, to) / CRASH_SAMPLE_STEP));
  let loT = 0; // последний параметр, где точка была в пределах допуска
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (offRoadDepth(track, lerp(from, to, t)) > OFFROAD_FORGIVE) {
      // Кромка допуска лежит в (loT, t] — уточняем бисекцией.
      let lo = loT;
      let hi = t;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        if (offRoadDepth(track, lerp(from, to, mid)) > OFFROAD_FORGIVE) hi = mid;
        else lo = mid;
      }
      return { crash: true, tCrash: hi, crashAt: lerp(from, to, hi) };
    }
    loT = t;
  }
  return { crash: false, tCrash: Infinity, crashAt: null };
}

export function candidates(state: GameState): Candidate[] {
  const p = state.players[state.current];
  const occupied = otherPositions(state);
  const out: Candidate[] = [];
  for (let ay = -1; ay <= 1; ay++) {
    for (let ax = -1; ax <= 1; ax++) {
      const target = { x: p.pos.x + p.vel.x + ax, y: p.pos.y + p.vel.y + ay };
      // Ход запрещён, если соперник стоит в конечной точке или отрезок хода
      // проходит через клетку, где соперник стоит сейчас (проехать «сквозь» нельзя).
      const blocked = occupied.some((o) => pointOnSegment(o, p.pos, target));
      out.push({
        target,
        blocked,
        crash: scanMove(state.track, p.pos, target).crash,
        inertial: ax === 0 && ay === 0,
      });
    }
  }
  return out;
}

/**
 * Позиции всех игроков, кроме ходящего сейчас и тех, кто отбывает штраф после
 * аварии — они ещё не вернулись на трассу и не мешают чужому пути.
 */
function otherPositions(state: GameState): Vec[] {
  return state.players
    .filter((pl, i) => i !== state.current && pl.skipTurns === 0)
    .map((pl) => ({ ...pl.pos }));
}

function nearestFreeInsidePoint(state: GameState, q: Vec): Vec {
  const occupied = new Set(otherPositions(state).map((o) => key(o.x, o.y)));
  let best: Vec | null = null;
  let bestD = Infinity;
  state.track.inside.forEach((k) => {
    if (occupied.has(k)) return;
    const p = unkey(k);
    const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    const better =
      d < bestD - 1e-9 ||
      (Math.abs(d - bestD) <= 1e-9 &&
        best !== null &&
        (p.y < best.y || (p.y === best.y && p.x < best.x)));
    if (better || best === null) {
      best = p;
      bestD = d;
    }
  });
  return best!;
}

export function applyMove(state: GameState, cand: Candidate): void {
  if (state.phase !== 'race' || cand.blocked) return;
  const track = state.track;
  const p = state.players[state.current];
  const from = { ...p.pos };
  const to = { ...cand.target };

  // Детект и точка аварии — одним проходом (тот же критерий, что в кандидатах).
  const { tCrash, crashAt } = scanMove(track, from, to);

  // Пересечение финишной линии засчитывается, только если случилось до аварии
  // и сторона линии реально сменилась (точка ровно на линии считается стороной
  // «впереди», чтобы не засчитывать одно пересечение дважды).
  const fin = segSegIntersection(from, to, track.finish.a, track.finish.b);
  if (fin && fin.t < tCrash) {
    const end = crashAt ?? to;
    const sFrom = sideOfFinish(track, from);
    const sTo = sideOfFinish(track, end);
    if (sFrom < 0 && sTo >= 0) p.crossings += 1;
    else if (sFrom >= 0 && sTo < 0) p.crossings -= 1;
  }

  if (crashAt) {
    // Болид остаётся в точке аварии на время штрафа — вернуть его на трассу
    // (nearestFreeInsidePoint) и дорисовать пунктирный «телепорт» нужно только
    // когда штраф отбыт (см. afterAction), иначе он мешает другим машинам.
    p.trail.push({ from, to: crashAt, jump: false });
    p.crashes.push(crashAt);
    p.pos = { ...crashAt };
    p.vel = { x: 0, y: 0 };
    // Скорость вылета — длина запланированного хода (|vel+accel|): чем быстрее
    // ехал, тем дальше в гравий и тем дольше выбираться.
    p.skipTurns = crashPenalty(state.rules, dist(from, to));
  } else {
    p.vel = { x: to.x - from.x, y: to.y - from.y };
    p.pos = to;
    p.trail.push({ from, to, jump: false });
  }

  if (p.crossings >= WIN_CROSSINGS && p.finishOvershoot === null) {
    p.finishOvershoot = sideOfFinish(track, crashAt ?? to);
  }

  afterAction(state);
}

/**
 * Смена хода и определение победителя. Игроки ходят по кругу в порядке индексов.
 * Как только кто-то финишировал, оставшиеся игроки этого же круга доигрывают
 * свои ходы (те, кто ходил раньше финишировавшего, свой шанс в этом круге уже
 * использовали). После этого среди всех финишировавших в решающем круге
 * побеждает заехавший дальше за линию; при равенстве — ничья.
 * Вынужденные пропуски после аварии проходят автоматически: если ход перешёл
 * к игроку, который ещё отбывает пропуск, он тратит один пропуск и ход сразу
 * уходит дальше — участнику ничего нажимать не нужно.
 */
function afterAction(state: GameState): void {
  const n = state.players.length;
  const i = state.current;
  const finished = state.players[i].crossings >= WIN_CROSSINGS;

  if (state.finalTurnsLeft !== null) {
    // Решающий круг уже идёт: этот ход укоротил число оставшихся.
    state.finalTurnsLeft -= 1;
    if (state.finalTurnsLeft <= 0) {
      decideWinner(state);
      return;
    }
  } else if (finished) {
    // Первый финиш: остальные игроки круга (после текущего) доигрывают.
    state.finalTurnsLeft = n - 1 - i;
    if (state.finalTurnsLeft <= 0) {
      decideWinner(state);
      return;
    }
  }

  state.current = (i + 1) % n;
  const next = state.players[state.current];
  if (next.skipTurns > 0) {
    next.skipTurns -= 1;
    if (next.skipTurns === 0) {
      // Штраф отбыт — только теперь возвращаем болид на трассу.
      const resetTo = nearestFreeInsidePoint(state, next.pos);
      next.trail.push({ from: { ...next.pos }, to: { ...resetTo }, jump: true });
      next.pos = resetTo;
    }
    afterAction(state);
  }
}

/**
 * Пропуск хода отсутствующего/задумавшегося игрока: болид продолжает ехать прямо
 * с той же скоростью (чистая инерция, ускорение 0,0). Если инерционная клетка
 * занята соперником — болид остаётся на месте с нулевой скоростью, а ход просто
 * уходит дальше. Аварии/пересечение финиша/боксы обрабатываются штатно через
 * applyMove. Детерминирована: два клиента, применившие coastMove к одному стейту,
 * получат идентичный результат (безопасно при last-write-wins в онлайне).
 */
export function coastMove(state: GameState): void {
  if (state.phase !== 'race') return;
  const p = state.players[state.current];
  // Болид стоит (старт / после аварии) — ехать по инерции некуда: просто пас,
  // без вырожденного следа нулевой длины на каждый пропуск.
  if (p.vel.x === 0 && p.vel.y === 0) {
    afterAction(state);
    return;
  }
  const inertial = candidates(state).find((c) => c.inertial)!;
  if (inertial.blocked) {
    p.vel = { x: 0, y: 0 };
    afterAction(state);
  } else {
    applyMove(state, inertial);
  }
}

/** Победитель решающего круга — максимальный заезд за линию среди финишировавших. */
function decideWinner(state: GameState): void {
  state.phase = 'over';
  let best = -Infinity;
  let winner: number | 'draw' | null = null;
  state.players.forEach((p, i) => {
    if (p.crossings < WIN_CROSSINGS) return;
    const o = p.finishOvershoot ?? 0;
    if (o > best + 1e-9) {
      best = o;
      winner = i;
    } else if (Math.abs(o - best) <= 1e-9) {
      winner = 'draw';
    }
  });
  state.winner = winner;
}
