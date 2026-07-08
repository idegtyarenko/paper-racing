// Очерёдность ходов: игроки ходят по очереди (схема очерёдности — rules.turnOrder:
// по кругу / змейкой / постоянная).
// Генерация кандидатов с блокировкой занятых клеток, применение хода одного
// болида, смена очереди и отбытие штрафа, пропуск по инерции (для онлайна).
// Общий расчёт исхода/победителя/возврата из штрафа — в game.ts.

import { pointOnSegment } from '../geometry';
import {
  GameState,
  Candidate,
  Rules,
  WIN_CROSSINGS,
  computeOutcome,
  applyOutcome,
  otherPositions,
  returnFromPenalty,
  decideWinner,
} from './game';

export function candidates(state: GameState): Candidate[] {
  const p = state.players[state.current];
  const occupied = otherPositions(state, state.current);
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
        crash: computeOutcome(state.track, state.rules, p.pos, target).crash,
        inertial: ax === 0 && ay === 0,
      });
    }
  }
  return out;
}

export function applyMove(state: GameState, cand: Candidate): void {
  if (state.phase !== 'race' || cand.blocked) return;
  const p = state.players[state.current];
  const outcome = computeOutcome(state.track, state.rules, p.pos, cand.target);
  applyOutcome(state.track, p, outcome);
  afterAction(state);
}

/**
 * Индекс игрока для сквозного слота хода. Круг = n слотов; позиция в круге (seat) —
 * turn % n, номер круга (round) — floor(turn / n). Схема очерёдности задаётся order:
 *  - 'rotate' — стартовый игрок сдвигается на round: (round + seat) % n.
 *    n=3: круг 1 — 0,1,2; круг 2 — 1,2,0; круг 3 — 2,0,1 (по кругу, без преимущества
 *    первого хода).
 *  - 'snake' — направление разворота задаётся последовательностью Тьюе-Морса
 *    (чётность числа единичных битов в номере круга), а не простым чередованием:
 *    это балансирует очерёдность так, что разворот на стыке кругов иногда
 *    повторяется, компенсируя предыдущий блок. n=3: 0,1,2 → 2,1,0 → 2,1,0 →
 *    0,1,2 → 2,1,0 → 0,1,2 → 0,1,2 → 2,1,0 (abc cba cba abc cba abc abc cba).
 *  - 'fixed' — очерёдность не меняется: всегда seat. n=3: 0,1,2 каждый круг.
 * Любая схема — перестановка всех игроков в каждом круге (никто не пропущен и не
 * ходит дважды) и детерминирована: одинаковый turn у всех клиентов даёт один индекс.
 */
function thueMorseParity(x: number): number {
  let n = x;
  let parity = 0;
  while (n > 0) {
    parity ^= n & 1;
    n >>>= 1;
  }
  return parity;
}

export function playerForTurn(
  turn: number,
  n: number,
  order: Rules['turnOrder'],
): number {
  const round = Math.floor(turn / n);
  const seat = turn % n;
  if (order === 'fixed') return seat;
  if (order === 'snake') return thueMorseParity(round) === 0 ? seat : n - 1 - seat;
  return (round + seat) % n;
}

/**
 * Смена хода и определение победителя. Игроки ходят по кругу; конкретную
 * очерёдность внутри круга задаёт схема rules.turnOrder (см. playerForTurn).
 * Число доигровок решающего круга (finalTurnsLeft) считается от позиции в круге
 * (seat) и от схемы не зависит. Как только кто-то финишировал,
 * оставшиеся игроки этого же круга доигрывают свои ходы (те, кто ходил раньше
 * финишировавшего в этом круге, свой шанс уже использовали). После этого среди
 * всех финишировавших в решающем круге побеждает заехавший дальше за линию; при
 * равенстве — ничья. Вынужденные пропуски после аварии проходят автоматически:
 * если ход перешёл к игроку, который ещё отбывает пропуск, он тратит один пропуск
 * и ход сразу уходит дальше — участнику ничего нажимать не нужно.
 */
function afterAction(state: GameState): void {
  const n = state.players.length;
  const seat = state.turn % n; // позиция ходящего в текущем круге
  const finished = state.players[state.current].crossings >= WIN_CROSSINGS;

  if (state.finalTurnsLeft !== null) {
    // Решающий круг уже идёт: этот ход укоротил число оставшихся.
    state.finalTurnsLeft -= 1;
    if (state.finalTurnsLeft <= 0) {
      decideWinner(state);
      return;
    }
  } else if (finished) {
    // Первый финиш: остальные игроки этого круга (после текущего seat) доигрывают.
    state.finalTurnsLeft = n - 1 - seat;
    if (state.finalTurnsLeft <= 0) {
      decideWinner(state);
      return;
    }
  }

  state.turn += 1;
  state.current = playerForTurn(state.turn, n, state.rules.turnOrder);
  const next = state.players[state.current];
  if (next.skipTurns > 0) {
    next.skipTurns -= 1;
    // Штраф отбыт — только теперь возвращаем болид на трассу.
    if (next.skipTurns === 0) returnFromPenalty(state, state.current);
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
