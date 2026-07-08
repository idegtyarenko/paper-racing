// Одновременный режим «вслепую»: все игроки выбирают ход, не видя выбор друг друга,
// затем весь раунд раскрывается разом. Кандидаты не блокируются занятыми клетками
// (проезд «сквозь» разрешён). Если несколько болидов приезжают в одну клетку —
// столкновение: их скорость падает до нуля. Общий расчёт исхода/победителя/возврата
// из штрафа — в game.ts.

import {
  GameState,
  Candidate,
  MoveOutcome,
  WIN_CROSSINGS,
  computeOutcome,
  applyOutcome,
  returnFromPenalty,
  decideWinner,
} from './game';
import { key } from './track';

/**
 * Девять кандидатов хода для указанного места — как в последовательном режиме, но
 * без вычисления blocked (в режиме вслепую занятые клетки не запрещены). Аварийные
 * клетки помечаются как обычно и остаются выбираемыми.
 */
export function simultaneousCandidates(state: GameState, seat: number): Candidate[] {
  const p = state.players[seat];
  const out: Candidate[] = [];
  for (let ay = -1; ay <= 1; ay++) {
    for (let ax = -1; ax <= 1; ax++) {
      const target = { x: p.pos.x + p.vel.x + ax, y: p.pos.y + p.vel.y + ay };
      out.push({
        target,
        blocked: false,
        crash: computeOutcome(state.track, state.rules, p.pos, target).crash,
        inertial: ax === 0 && ay === 0,
      });
    }
  }
  return out;
}

/**
 * Следующее место, которому нужно выбрать ход в этом раунде: не отбывает штраф
 * (skipTurns === 0) и ещё не подтвердило выбор (pending === null). null — все
 * активные болиды уже выбрали (раунд можно разрешать).
 */
export function nextPickSeat(state: GameState): number | null {
  const pending = state.pending;
  if (!pending) return null;
  for (let i = 0; i < state.players.length; i++) {
    if (state.players[i].skipTurns === 0 && pending[i] === null) return i;
  }
  return null;
}

/** Записать (вслепую) выбор места в буфер раунда. Выбор не применяется и не рисуется. */
export function submitBlindMove(state: GameState, seat: number, cand: Candidate): void {
  if (state.pending) state.pending[seat] = cand;
}

/** Все ли активные болиды подтвердили ход (раунд готов к разрешению). */
export function allSubmitted(state: GameState): boolean {
  return state.pending !== null && nextPickSeat(state) === null;
}

/** Продвинуть штраф болида на 1 и вернуть на трассу, если отбыл до нуля. */
function advancePenalty(state: GameState, seat: number): void {
  const p = state.players[seat];
  p.skipTurns -= 1;
  if (p.skipTurns === 0) returnFromPenalty(state, seat);
}

/**
 * Разрешить раунд одновременных ходов: посчитать исходы всех подтвердивших болидов,
 * обработать столкновения (несколько в одну клетку → скорость обнуляется), применить
 * всё сразу, определить победу, продвинуть штрафы и открыть новый раунд.
 */
export function resolveRound(state: GameState): void {
  if (state.phase !== 'race' || !state.pending) return;
  const n = state.players.length;
  const moved = state.pending.map((c) => c !== null); // кто ходил в этом раунде

  // 1. Исходы ходивших болидов (чистый расчёт, без мутации).
  const outcomes: (MoveOutcome | null)[] = state.players.map((p, i) =>
    moved[i]
      ? computeOutcome(state.track, state.rules, p.pos, state.pending![i]!.target)
      : null,
  );

  // 2. Столкновения: неаварийные болиды, приехавшие в одну клетку, теряют скорость.
  const arrivals = new Map<number, number>();
  outcomes.forEach((o) => {
    if (o && !o.crash) {
      const k = key(o.end.x, o.end.y);
      arrivals.set(k, (arrivals.get(k) ?? 0) + 1);
    }
  });
  outcomes.forEach((o) => {
    if (o && !o.crash && (arrivals.get(key(o.end.x, o.end.y)) ?? 0) > 1) {
      o.vel = { x: 0, y: 0 };
    }
  });

  // 3. Применяем исходы всем сразу — раскрытие раунда.
  outcomes.forEach((o, i) => {
    if (o) applyOutcome(state.track, state.players[i], o);
  });

  // 4. Победа: раунд честный (все сходили поровну), решающего добора не нужно —
  // если кто-то финишировал, сразу определяем победителя по глубине заезда.
  if (state.players.some((p) => p.crossings >= WIN_CROSSINGS)) {
    decideWinner(state);
    return;
  }

  // 5. Отбывающие штраф болиды, не ходившие в этом раунде, продвигают штраф на 1
  // (свежеразбившиеся начнут отбывать со следующего раунда).
  state.players.forEach((p, i) => {
    if (!moved[i] && p.skipTurns > 0) advancePenalty(state, i);
  });

  // 6. Новый раунд: обнулить выборы, продвинуть счётчик. Пустые раунды (все болиды
  // в гравии) проматываем — иначе выбирать некому и был бы тупик.
  state.pending = state.players.map(() => null);
  state.turn += n;
  while (state.phase === 'race' && nextPickSeat(state) === null) {
    state.players.forEach((_, i) => {
      if (state.players[i].skipTurns > 0) advancePenalty(state, i);
    });
    state.turn += n;
  }
  state.current = nextPickSeat(state) ?? 0;
}
