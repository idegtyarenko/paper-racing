// Игровой движок: состояние гонки, кандидаты хода, аварии, финиш, победа.
// Чистая логика без DOM.

import {
  Vec,
  dist,
  lerp,
  distPointToPolyline,
  segSegIntersection,
  segmentPolylineIntersections,
} from "./geometry";
import { Track, key, unkey, sideOfFinish, onRoad } from "./track";

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

/** Круг завершён, когда счётчик достиг 2: первое пересечение — сразу после
 * старта из-за линии («круг начался»), второе — полный круг. */
export const WIN_CROSSINGS = 2;

export interface GameState {
  track: Track;
  players: [Player, Player];
  current: 0 | 1;
  phase: "race" | "over";
  winner: 0 | 1 | "draw" | null;
  /** Игрок 0 финишировал в этом раунде; игрок 1 ещё доигрывает свой ход. */
  pendingWinner: 0 | null;
}

export interface Candidate {
  target: Vec;
  crash: boolean;
  /** Точка занята соперником — ход запрещён. */
  blocked: boolean;
  /** Кандидат чистой инерции (ускорение 0,0). */
  inertial: boolean;
}

export function newGame(track: Track): GameState {
  const mk = (i: 0 | 1): Player => ({
    name: `Игрок ${i + 1}`,
    color: i === 0 ? "#c62828" : "#1565c0",
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
    players: [mk(0), mk(1)],
    current: 0,
    phase: "race",
    winner: null,
    pendingWinner: null,
  };
}

/**
 * Насколько игра «прощает» заезд за край трассы, в клетках. Ход, вылезший за
 * стенку не глубже этого допуска (и путь, лишь задевающий стенку не глубже),
 * аварией не считается — игрок может проскочить впритирку. Ноль вернул бы
 * прежнюю строгость «точно по кромке».
 */
const FORGIVE = 0.15;

/** Насколько глубоко точка зашла за край дороги: 0 на дороге, иначе — до ближайшей стенки. */
function offRoadDepth(track: Track, p: Vec): number {
  if (onRoad(p, track.outer, track.inner)) return 0;
  return Math.min(
    distPointToPolyline(p, track.outer),
    distPointToPolyline(p, track.inner),
  );
}

/**
 * Ход — авария, только если где-то вдоль отрезка (включая конечную точку) он
 * заходит за стенку глубже допуска FORGIVE. Точку хода густо семплим, чтобы
 * ловить и заезды «насквозь» через газон, и глубокие срезы углов, но прощать
 * касания впритирку. Стартовая точка всегда на дороге, поэтому её пропускаем.
 */
function moveCrashes(track: Track, from: Vec, to: Vec): boolean {
  const steps = Math.max(2, Math.ceil(dist(from, to) / 0.2));
  for (let i = 1; i <= steps; i++) {
    if (offRoadDepth(track, lerp(from, to, i / steps)) > FORGIVE) return true;
  }
  return false;
}

export function candidates(state: GameState): Candidate[] {
  const p = state.players[state.current];
  const opp = state.players[1 - state.current];
  const out: Candidate[] = [];
  for (let ay = -1; ay <= 1; ay++) {
    for (let ax = -1; ax <= 1; ax++) {
      const target = { x: p.pos.x + p.vel.x + ax, y: p.pos.y + p.vel.y + ay };
      out.push({
        target,
        blocked: target.x === opp.pos.x && target.y === opp.pos.y,
        crash: moveCrashes(state.track, p.pos, target),
        inertial: ax === 0 && ay === 0,
      });
    }
  }
  return out;
}

function nearestFreeInsidePoint(state: GameState, q: Vec): Vec {
  const opp = state.players[1 - state.current];
  const oppKey = key(opp.pos.x, opp.pos.y);
  let best: Vec | null = null;
  let bestD = Infinity;
  state.track.inside.forEach((k) => {
    if (k === oppKey) return;
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
  if (state.phase !== "race" || cand.blocked) return;
  const track = state.track;
  const p = state.players[state.current];
  const from = { ...p.pos };
  const to = { ...cand.target };

  // Точка аварии — первое пересечение отрезка хода со стенкой.
  let tCrash = Infinity;
  let crashAt: Vec | null = null;
  if (cand.crash) {
    const hits = [
      ...segmentPolylineIntersections(from, to, track.outer),
      ...segmentPolylineIntersections(from, to, track.inner),
    ].sort((a, b) => a.t - b.t);
    if (hits.length > 0) {
      tCrash = hits[0].t;
      crashAt = hits[0].point;
    } else {
      // Конечная точка вне дороги, но стенку отрезок не пересёк (вылет «в
      // стенку целиком» за зазором) — считаем аварией в конечной точке.
      tCrash = 1;
      crashAt = to;
    }
  }

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
    const resetTo = nearestFreeInsidePoint(state, crashAt);
    p.trail.push({ from, to: crashAt, jump: false });
    p.trail.push({ from: crashAt, to: { ...resetTo }, jump: true });
    p.crashes.push(crashAt);
    p.pos = { ...resetTo };
    p.vel = { x: 0, y: 0 };
    p.skipTurns = 2;
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

/** Пропуск хода после аварии — тоже действие игрока в раунде. */
export function skipTurn(state: GameState): void {
  if (state.phase !== "race") return;
  const p = state.players[state.current];
  if (p.skipTurns <= 0) return;
  p.skipTurns -= 1;
  afterAction(state);
}

/**
 * Смена хода и определение победителя. Игрок 0 всегда ходит первым в раунде.
 * Если он финишировал, игрок 1 доигрывает свой ход того же раунда — при
 * двойном финише сравнивается перпендикулярное расстояние за линией.
 */
function afterAction(state: GameState): void {
  const i = state.current;
  const p = state.players[i];
  const finished = p.crossings >= WIN_CROSSINGS;

  if (i === 0) {
    if (finished) state.pendingWinner = 0;
    state.current = 1;
  } else {
    if (state.pendingWinner === 0) {
      if (finished) {
        const o0 = state.players[0].finishOvershoot ?? 0;
        const o1 = p.finishOvershoot ?? 0;
        state.winner = o1 > o0 ? 1 : o0 > o1 ? 0 : "draw";
      } else {
        state.winner = 0;
      }
      state.phase = "over";
    } else if (finished) {
      state.winner = 1;
      state.phase = "over";
    }
    state.current = 0;
  }
}
