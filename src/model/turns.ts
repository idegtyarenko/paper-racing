// Очерёдность ходов: игроки ходят по очереди (схема очерёдности — rules.turnOrder:
// по кругу / змейкой / постоянная).
// Генерация кандидатов с блокировкой занятых клеток, применение хода одного
// болида, смена очереди и отбытие штрафа, пропуск по инерции (для онлайна).
// Общий расчёт исхода/победителя/возврата из штрафа — в game.ts.

import { Vec, pointOnSegment } from '../geometry';
import { REALISTIC_GRIP, REALISTIC_ACCEL } from '../config';
import {
  GameState,
  Candidate,
  Rules,
  WIN_CROSSINGS,
  computeOutcome,
  applyOutcome,
  otherPositions,
  returnFromPenalty,
  resolveRound,
} from './game';

/**
 * Достижимые цели хода из состояния (pos, vel) по модели физики. Единая точка
 * генерации целей — её зовут и движок (candidates), и планировщик бота (ai/targets),
 * поэтому бот раскрывает ровно те же ходы, что доступны игроку. В следующем пункте
 * арки две ветки сольются в одну параметризованную модель (классика = пресет
 * управляемости/разгона = 1) — тогда меняется только тело этой функции.
 */
export function reachableTargets(pos: Vec, vel: Vec, physics: Rules['physics']): Vec[] {
  return physics === 'realistic' ? realisticTargets(pos, vel) : classicTargets(pos, vel);
}

/**
 * Классическая модель Racetrack: 9 целей — ускорение ±1 клетка по каждой оси вокруг
 * точки наката C = pos + vel.
 */
function classicTargets(pos: Vec, vel: Vec): Vec[] {
  const out: Vec[] = [];
  for (let ay = -1; ay <= 1; ay++) {
    for (let ax = -1; ax <= 1; ax++) {
      out.push({ x: pos.x + vel.x + ax, y: pos.y + vel.y + ay });
    }
  }
  return out;
}

/**
 * Реалистичная модель («круг сцепления»): целые узлы вокруг точки наката C = pos + vel,
 * для которых изменение скорости a = target − C проходит по бюджету сцепления:
 *  - |a| ≤ REALISTIC_GRIP — общий круг сцепления (делится между разгоном/торможением и
 *    поворотом: тормозишь в пол — a смотрит назад, на поворот не осталось; и наоборот);
 *  - вперёд продольная составляющая a·û ≤ REALISTIC_ACCEL (û = vel/|vel|) — потолок
 *    разгона; назад (торможение) доступен весь GRIP, поэтому тормозит быстрее, чем
 *    разгоняется;
 *  - на старте (vel = 0) направления нет: разгон в любую сторону |a| ≤ REALISTIC_ACCEL.
 * Скорость учитывается сама: доворот на угол θ требует поперечного Δv ≈ |vel|·θ, значит
 * θ_max ≈ GRIP/|vel| — чем быстрее, тем меньше доворот за ход. Точка наката (a = 0)
 * всегда в наборе (0 ≤ любой порог), так что инерция/пропуск работают как в классике.
 */
function realisticTargets(pos: Vec, vel: Vec): Vec[] {
  const cx = pos.x + vel.x;
  const cy = pos.y + vel.y;
  const speed = Math.hypot(vel.x, vel.y);
  const grip2 = REALISTIC_GRIP * REALISTIC_GRIP;
  const accel2 = REALISTIC_ACCEL * REALISTIC_ACCEL;
  const r = Math.floor(REALISTIC_GRIP); // целых узлов дальше радиуса круга не бывает
  const EPS = 1e-9;
  const out: Vec[] = [];
  for (let ay = -r; ay <= r; ay++) {
    for (let ax = -r; ax <= r; ax++) {
      const len2 = ax * ax + ay * ay;
      if (len2 > grip2 + EPS) continue; // вне круга сцепления
      if (speed > 0) {
        const along = (ax * vel.x + ay * vel.y) / speed; // продольно вдоль скорости
        if (along > REALISTIC_ACCEL + EPS) continue; // потолок разгона вперёд
      } else if (len2 > accel2 + EPS) {
        continue; // старт: разгон не больше потолка
      }
      out.push({ x: cx + ax, y: cy + ay });
    }
  }
  return out;
}

export function candidates(state: GameState): Candidate[] {
  const p = state.players[state.current];
  const occupied = otherPositions(state, state.current);
  const cx = p.pos.x + p.vel.x; // точка наката C (чистая инерция, a = 0)
  const cy = p.pos.y + p.vel.y;
  const targets = reachableTargets(p.pos, p.vel, state.rules.physics);
  return targets.map((target) => ({
    target,
    // Ход запрещён, если соперник стоит в конечной точке или отрезок хода проходит
    // через клетку, где соперник стоит сейчас (проехать «сквозь» нельзя).
    blocked: occupied.some((o) => pointOnSegment(o, p.pos, target)),
    crash: computeOutcome(state.track, state.rules, p.pos, target).crash,
    inertial: target.x === cx && target.y === cy,
  }));
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
 * Очередь ближайших ходов: индексы игроков, которые реально будут ходить,
 * начиная с текущего (первый элемент — state.current). count — сколько ходов
 * вернуть. Учитывает штрафные пропуски (болид в гравии не появляется в очереди,
 * пока не отбудет штраф) и доигровку решающего круга (finalTurnsLeft ограничивает
 * число оставшихся слотов) — ровно как afterAction. Прогноз детерминирован и верен
 * в предположении, что новых аварий не случится: каждый слот продвигает turn на 1,
 * слот игрока в боксах «сгорает» на отбытие штрафа и хода не даёт. Прошлые ходы не
 * восстанавливаются (журнала ходов нет) — очередь смотрит только вперёд.
 */
export function upcomingTurns(state: GameState, count: number): number[] {
  const n = state.players.length;
  const skips = state.players.map((p) => p.skipTurns);
  const out: number[] = [];
  let turn = state.turn;
  let slotsLeft = state.finalTurnsLeft; // null — раунд не идёт, слотов не ограничено
  while (out.length < count && (slotsLeft === null || slotsLeft > 0)) {
    const seat = playerForTurn(turn, n, state.rules.turnOrder);
    const p = state.players[seat];
    if (p.place !== null || p.retired) {
      // Выбывший (получил место / сдался) хода не делает — слот сгорает.
    } else if (skips[seat] > 0) {
      skips[seat] -= 1; // слот сгорает на отбытие штрафа
    } else {
      out.push(seat);
    }
    turn += 1;
    if (slotsLeft !== null) slotsLeft -= 1;
  }
  return out;
}

/**
 * Смена хода и учёт финиша. Игроки ходят по кругу; конкретную очерёдность внутри
 * круга задаёт схема rules.turnOrder (см. playerForTurn). Как только кто-то
 * пересекает финиш, открывается «раунд»: остальные болиды этого же круга (после
 * текущего seat) доигрывают свои ходы — те, кто ходил раньше, свой шанс в этом
 * круге уже использовали. По исчерпании раунда resolveRound раздаёт места
 * финишировавшим в нём по глубине заезда за линию. В отличие от прежней логики
 * гонка на этом не заканчивается: следующие круги играют оставшиеся болиды, пока
 * все не финишируют или не сдадутся (тогда resolveRound/retireCurrent выставит
 * phase='over'). Выбывшие болиды (place присвоен или сдался) в очереди
 * пропускаются автоматически — их слот сгорает без хода, как и штрафной пропуск
 * после аварии.
 */
function afterAction(state: GameState): void {
  if (state.phase !== 'race') return;
  const n = state.players.length;
  const seat = state.turn % n; // позиция ходящего в текущем круге
  const cur = state.players[state.current];

  // Болид только что пересёк финиш нужное число раз и ещё не в этом раунде —
  // засчитываем его в текущий раунд.
  const finished =
    cur.crossings >= WIN_CROSSINGS &&
    cur.place === null &&
    !state.roundFinishers.includes(state.current);
  if (finished) state.roundFinishers.push(state.current);

  if (state.finalTurnsLeft !== null) {
    // Раунд уже шёл до этого хода: он укоротил число оставшихся в нём слотов
    // (сам ход финишировавшего, открывшего раунд, слотом не считается — он в
    // ветке else ниже, где finalTurnsLeft = число болидов ПОСЛЕ него в круге).
    state.finalTurnsLeft -= 1;
    if (state.finalTurnsLeft <= 0) {
      resolveRound(state); // раздаёт места, может выставить phase='over'
      if (state.phase !== 'race') return;
    }
  } else if (finished) {
    // Первый финиш раунда: болиды этого круга после текущего seat доигрывают.
    state.finalTurnsLeft = n - 1 - seat;
    if (state.finalTurnsLeft <= 0) {
      resolveRound(state);
      if (state.phase !== 'race') return;
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
  } else if (next.place !== null || next.retired) {
    // Выбывший из гонки хода не делает — слот сгорает, ход идёт дальше.
    afterAction(state);
  }
}

/**
 * Сдача игрока: болид seat выбывает из гонки (места не занимает, ходов не
 * делает). Сдаться можно в любой момент, не обязательно в свой ход. Если после
 * сдачи активных болидов не осталось — гонка окончена. Если сдался тот, чей
 * сейчас ход, — ход передаётся дальше (afterAction учитывает бухгалтерию
 * раунда); если сдался не ходящий сейчас — очередь не трогаем, его слот
 * пропустится сам, когда до него дойдёт (afterAction/upcomingTurns).
 */
export function retireSeat(state: GameState, seat: number): void {
  if (state.phase !== 'race') return;
  const p = state.players[seat];
  if (p.place !== null || p.retired) return;
  p.retired = true;
  if (state.players.every((pl) => pl.place !== null || pl.retired)) {
    state.phase = 'over';
    return;
  }
  if (seat === state.current) afterAction(state);
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
