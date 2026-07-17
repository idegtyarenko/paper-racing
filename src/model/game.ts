// Игровой движок — общее ядро: состояние гонки, правила, расчёт исхода одного хода
// (авария, финиш, новые pos/vel/след), возврат из штрафа и определение победителя.
// Чистая логика без DOM. Очерёдность ходов вынесена в turns.ts.

import { Vec, dist, lerp, distPointToPolyline, segSegIntersection } from '../geometry';
import { Track, key, unkey, sideOfFinish, onRoad } from './track';
import type { Difficulty } from './ai/difficulty';
import { strings } from '../strings';
import {
  MIN_PLAYERS,
  WIN_CROSSINGS,
  CRASH_SKIP_TURNS,
  CRASH_PENALTY_MAX,
  OFFROAD_FORGIVE,
  CRASH_SAMPLE_STEP,
  TURN_TIMEOUT_MS,
  DRIVE_PRESETS,
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
  /**
   * Итоговое место (1-based), присвоенное после разрешения раунда, в котором
   * болид финишировал; null — ещё едет / сдался / финишировал, но раунд не
   * разрешён. Делится при равном заезде за линию («1224»: два вторых → следующий
   * четвёртый).
   */
  place: number | null;
  /** Игрок сдался — выбыл из гонки, места не занимает и ходов не делает. */
  retired: boolean;
  /**
   * Место занято ботом этой сложности; undefined — за местом человек. Хранится в
   * модели (а не сайд-каналом), поэтому едет вместе со стейтом: и в онлайн-синк
   * (гости видят ботов), и в локальный снимок persist — отдельной сериализации не
   * нужно (serializeState структурно копирует все поля игрока). Ходы ботов считает
   * chooseMove; в онлайне их коммитит только хост (см. online-controller).
   */
  bot?: Difficulty;
}

// Число пересечений финиша для победы (см. WIN_CROSSINGS в config) — реэкспорт.
export { WIN_CROSSINGS };

/**
 * Управляемость машины: три независимых полуоси «эллипса сцепления» (клетки/ход) —
 * разгон вперёд, торможение назад, маневр вбок. См. reachableTargets в turns.ts и
 * пресеты DRIVE_PRESETS в config.
 */
export interface Drive {
  accel: number;
  brake: number;
  maneuver: number;
}

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
  /**
   * Управляемость машины (генерация ходов, см. reachableTargets в turns.ts): три
   * независимых полуоси «эллипса сцепления» в клетках/ход — разгон вперёд, торможение
   * назад, маневр вбок. Все три равны → изотропный круг = классика 3×3; анизотропия
   * даёт гоночные траектории. Пресеты — DRIVE_PRESETS в config. Бот играет по этой же
   * модели (планировщик зовёт reachableTargets), отдельной «классики для бота» нет.
   */
  drive: Drive;
  /**
   * Лимит времени на ход, мс. Действует только в онлайне: по его истечении ход
   * присутствующего, но задумавшегося игрока становится доступен остальным для
   * ручного пропуска, а ход отсутствующего авто-пропускает назначенный клиент
   * (см. armTurnWatch в online-controller.ts). В hotseat/против бота не влияет.
   */
  turnLimitMs: number;
}

/** Правила по умолчанию: динамический штраф со стандартной (линейной) строгостью, реалистичная управляемость. */
export const DEFAULT_RULES: Rules = {
  penalty: 'dynamic',
  staticTurns: CRASH_SKIP_TURNS,
  dynamicExponent: 1,
  drive: { ...DRIVE_PRESETS.realistic },
  turnLimitMs: TURN_TIMEOUT_MS,
};

/**
 * Привести (частичные) правила из стейта/снимка к полным, с бэкфиллом дефолтами и
 * миграцией легаси-поля physics ('classic'|'realistic') в drive. Используется на всех
 * точках десериализации (онлайн-стейт, восстановление из persist), чтобы старые
 * строки без drive поднимались корректно. drive всегда клонируется — свежий объект,
 * не связанный с исходным снимком (настройки его мутируют).
 */
export function normalizeRules(
  partial: (Partial<Rules> & { physics?: string }) | undefined,
): Rules {
  const { physics, ...rest } = partial ?? {};
  const legacy =
    physics === 'realistic'
      ? DRIVE_PRESETS.realistic
      : physics === 'classic'
        ? DRIVE_PRESETS.classic
        : null;
  const merged = { ...DEFAULT_RULES, ...rest };
  merged.drive = { ...(rest.drive ?? legacy ?? DEFAULT_RULES.drive) };
  return merged;
}

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
  /**
   * Сквозной счётчик слотов хода (0-based) для честной очерёдности. Круг — это
   * n слотов; на каждом круге стартовый игрок сдвигается на 1, чтобы убрать
   * преимущество первого. Игрок слота задаётся playerForTurn(); current держим
   * в синхроне для остального кода, читающего его как индекс ходящего.
   */
  turn: number;
  phase: 'race' | 'over';
  /**
   * Победитель гонки (место 1). Определяется при разрешении первого раунда, где
   * кто-то финишировал, и дальше не меняется. `'draw'` — если 1-е место
   * разделили несколько болидов с равным заездом за линию. Гонка при этом
   * продолжается для остальных (см. phase).
   */
  winner: number | 'draw' | null;
  /**
   * Сколько ходов осталось доиграть в текущем раунде. null — раунд не идёт
   * (никто в нём ещё не пересёк финиш). Как только кто-то пересекает финиш,
   * остальные болиды этого же круга доигрывают свои ходы (это число); по
   * исчерпании раунд разрешается (resolveRound) — финишировавшим в нём
   * раздаются места по глубине заезда за линию. В отличие от прежней логики
   * гонка на этом не заканчивается: следующие круги играют оставшиеся болиды,
   * пока все не финишируют или не сдадутся.
   */
  finalTurnsLeft: number | null;
  /**
   * Болиды (seat'ы), пересёкшие финиш в текущем ещё не разрешённом раунде и
   * ждущие расстановки мест. Опустошается в resolveRound.
   */
  roundFinishers: number[];
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

/**
 * Случайная перестановка индексов [0..n) (Фишер—Йетс). rng инъектируется (как в
 * chooseMove бота) — по умолчанию Math.random. Используется для случайной раздачи
 * стартовых слотов болидам: в онлайне зовётся только у хоста и уезжает в
 * сериализованном стейте, так что сеять одинаково у всех клиентов не нужно.
 */
export function shuffledIndices(n: number, rng: () => number = Math.random): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function newGame(
  track: Track,
  playerCount = 2,
  rules: Rules = DEFAULT_RULES,
  // Перестановка стартовых слотов: болид i встаёт на startPoints[startOrder[i]].
  // По умолчанию — тождественная (поул у seat 0): детерминизм тестов/фикстуры.
  startOrder?: number[],
): GameState {
  const n = Math.max(
    MIN_PLAYERS,
    Math.min(MAX_PLAYERS, playerCount, track.startPoints.length),
  );
  const mk = (i: number): Player => ({
    name: NAMES[i],
    color: COLORS[i],
    pos: { ...track.startPoints[startOrder?.[i] ?? i] },
    vel: { x: 0, y: 0 },
    trail: [],
    crashes: [],
    skipTurns: 0,
    crossings: 0,
    finishOvershoot: null,
    place: null,
    retired: false,
  });
  return {
    track,
    players: Array.from({ length: n }, (_, i) => mk(i)),
    rules,
    current: 0,
    turn: 0,
    phase: 'race',
    winner: null,
    finalTurnsLeft: null,
    roundFinishers: [],
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
export function offRoadDepth(track: Track, p: Vec): number {
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

/** Результат хода одного болида — чистые данные для применения (без мутации игрока). */
export interface MoveOutcome {
  /** Где болид оказался: crashAt при аварии, иначе целевая клетка. */
  end: Vec;
  /** Новая скорость (нулевая при аварии). */
  vel: Vec;
  crash: boolean;
  crashAt: Vec | null;
  /** Штраф в ходах при аварии, иначе 0. */
  skipTurns: number;
  /** Изменение счётчика пересечений финиша: −1 / 0 / +1. */
  crossingDelta: number;
  trailSeg: TrailSeg;
}

/**
 * Посчитать исход хода болида из точки from в клетку target — авария и её точка,
 * пересечение финиша, новые скорость/след. Чистая функция, ничего не мутирует;
 * применяет результат applyOutcome.
 */
/**
 * Знак пересечения финиша отрезком from→to: +1 (вперёд), −1 (назад) или 0. Точка
 * ровно на линии считается стороной «впереди» (sideOfFinish >= 0), чтобы не
 * засчитывать одно пересечение дважды. tCrashCutoff отсекает пересечения после
 * аварии (для чистого хода; телепорт возврата аварии не имеет — Infinity).
 */
function finishCrossingDelta(
  track: Track,
  from: Vec,
  to: Vec,
  tCrashCutoff = Infinity,
): number {
  const fin = segSegIntersection(from, to, track.finish.a, track.finish.b);
  if (!fin || fin.t >= tCrashCutoff) return 0;
  const sFrom = sideOfFinish(track, from);
  const sTo = sideOfFinish(track, to);
  if (sFrom < 0 && sTo >= 0) return 1;
  if (sFrom >= 0 && sTo < 0) return -1;
  return 0;
}

export function computeOutcome(
  track: Track,
  rules: Rules,
  from: Vec,
  target: Vec,
): MoveOutcome {
  const to = { ...target };
  const { tCrash, crashAt } = scanMove(track, from, to);

  // Пересечение финишной линии засчитывается, только если случилось до аварии
  // (tCrash отсекает пересечения после точки вылета).
  const crossingDelta = finishCrossingDelta(track, from, to, tCrash);

  if (crashAt) {
    return {
      end: { ...crashAt },
      vel: { x: 0, y: 0 },
      crash: true,
      crashAt: { ...crashAt },
      // Скорость вылета — длина запланированного хода (|vel+accel|): чем быстрее
      // ехал, тем дальше в гравий и тем дольше выбираться.
      skipTurns: crashPenalty(rules, dist(from, to)),
      crossingDelta,
      trailSeg: { from: { ...from }, to: { ...crashAt }, jump: false },
    };
  }
  return {
    end: { ...to },
    vel: { x: to.x - from.x, y: to.y - from.y },
    crash: false,
    crashAt: null,
    skipTurns: 0,
    crossingDelta,
    trailSeg: { from: { ...from }, to: { ...to }, jump: false },
  };
}

/**
 * Применить посчитанный исход к болиду: обновить счётчик финиша, след, аварию,
 * позицию/скорость/штраф и (при достижении победы) глубину заезда за линию.
 * Смену очереди и определение победителя вызывающий делает сам (см. turns.ts).
 */
export function applyOutcome(track: Track, p: Player, o: MoveOutcome): void {
  p.crossings += o.crossingDelta;
  p.trail.push(o.trailSeg);
  if (o.crashAt) {
    // Болид остаётся в точке аварии на время штрафа — вернуть его на трассу
    // (returnFromPenalty) нужно только когда штраф отбыт, иначе он мешает другим.
    p.crashes.push({ ...o.crashAt });
  }
  p.pos = { ...o.end };
  p.vel = { ...o.vel };
  p.skipTurns = o.skipTurns;
  if (p.crossings >= WIN_CROSSINGS && p.finishOvershoot === null) {
    p.finishOvershoot = sideOfFinish(track, o.end);
  }
}

/**
 * Болид завершил гонку и больше не ходит: получил место ИЛИ уже пересёк финиш
 * нужное число раз (finishOvershoot выставляется на самом пересечении, а place —
 * позже, в resolveRound, когда доиграется раунд). В этом окне place ещё null, но
 * ходить/намечать ход финишировавшему уже нельзя — поэтому проверять надо именно
 * это, а не один place. NB: на трассе он в это окно ещё стоит и блокирует
 * (см. otherPositions) — здесь речь только про право хода.
 */
export function isFinished(p: Player): boolean {
  return p.place !== null || p.finishOvershoot !== null;
}

/**
 * Позиции всех игроков, кроме указанного места и тех, кто не мешает чужому пути:
 * отбывающих штраф после аварии (ещё не вернулись на трассу), а также выбывших
 * из гонки — уже получивших место (разрешённый раунд) или сдавшихся. Болиды,
 * пересёкшие финиш, но ждущие расстановки мест (place === null), пока стоят на
 * трассе и блокируют, как любой активный.
 */
export function otherPositions(state: GameState, exclude: number): Vec[] {
  return state.players
    .filter(
      (pl, i) => i !== exclude && pl.skipTurns === 0 && pl.place === null && !pl.retired,
    )
    .map((pl) => ({ ...pl.pos }));
}

/** Ближайшая свободная (не занятая другим болидом) клетка трассы к точке q. */
export function nearestFreeInsidePoint(state: GameState, q: Vec, exclude: number): Vec {
  const occupied = new Set(otherPositions(state, exclude).map((o) => key(o.x, o.y)));
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

/**
 * Штраф отбыт — вернуть болид на ближайшую свободную клетку трассы с пунктирным
 * «телепортом» из гравия (см. afterAction в turns.ts).
 */
export function returnFromPenalty(state: GameState, seat: number): void {
  const p = state.players[seat];
  const { track } = state;
  const resetTo = nearestFreeInsidePoint(state, p.pos, seat);
  // Телепорт возврата может перебросить болид за линию финиша — засчитываем
  // пересечение, иначе круг, «доеханный» до аварии, потеряется. Смена стороны
  // считается так же, как в computeOutcome (afterAction затем поймает финиш).
  p.crossings += finishCrossingDelta(track, p.pos, resetTo);
  if (p.crossings >= WIN_CROSSINGS && p.finishOvershoot === null) {
    p.finishOvershoot = sideOfFinish(track, resetTo);
  }
  p.trail.push({ from: { ...p.pos }, to: { ...resetTo }, jump: true });
  p.pos = resetTo;
}

/**
 * Разрешить текущий раунд: раздать места болидам, пересёкшим в нём финиш
 * (state.roundFinishers), по глубине заезда за линию (finishOvershoot) —
 * заехавший дальше получает место выше. Спортивная нумерация «1224»: равный
 * заезд даёт одинаковое место, а следующий за парой — место со сдвигом (два
 * вторых → следующий четвёртый). Победитель гонки (place 1) фиксируется при
 * первом же разрешённом раунде с финишировавшими; если 1-е место разделили —
 * `'draw'`. Когда все болиды получили место или сдались — гонка окончена.
 */
export function resolveRound(state: GameState): void {
  const ranked = [...state.roundFinishers].sort(
    (a, b) =>
      (state.players[b].finishOvershoot ?? -Infinity) -
      (state.players[a].finishOvershoot ?? -Infinity),
  );
  const already = state.players.filter((p) => p.place !== null).length;
  let place = already + 1;
  ranked.forEach((seat, i) => {
    if (i > 0) {
      const prev = state.players[ranked[i - 1]].finishOvershoot ?? 0;
      const cur = state.players[seat].finishOvershoot ?? 0;
      if (Math.abs(cur - prev) > 1e-9) place = already + i + 1;
    }
    state.players[seat].place = place;
  });

  if (state.winner === null && ranked.length > 0) {
    const firstPlace = state.players[ranked[0]].place;
    const firsts = ranked.filter((s) => state.players[s].place === firstPlace);
    state.winner = firsts.length > 1 ? 'draw' : firsts[0];
  }

  state.roundFinishers = [];
  state.finalTurnsLeft = null;
  if (state.players.every((p) => p.place !== null || p.retired)) {
    state.phase = 'over';
  }
}
