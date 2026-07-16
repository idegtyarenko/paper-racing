// Очерёдность ходов: игроки ходят по кругу (стартовый сдвигается каждый круг).
// Генерация кандидатов с блокировкой занятых клеток, применение хода одного
// болида, смена очереди и отбытие штрафа, пропуск по инерции (для онлайна).
// Общий расчёт исхода/победителя/возврата из штрафа — в game.ts.

import { Vec, pointOnSegment } from '../geometry';
import { MIN_LAUNCH } from '../config';
import {
  GameState,
  Candidate,
  Drive,
  WIN_CROSSINGS,
  computeOutcome,
  applyOutcome,
  otherPositions,
  returnFromPenalty,
  resolveRound,
} from './game';

/**
 * Достижимые цели хода из состояния (pos, vel) по управляемости drive — единая
 * параметризованная модель для всех режимов (классика — изотропный пресет). Её зовут
 * и движок (candidates), и планировщик бота (ai/planner), поэтому бот раскрывает ровно
 * те же ходы, что доступны игроку.
 *
 * Вокруг точки наката C = pos + vel лежит «эллипс сцепления» в системе координат
 * скорости: целые узлы, у которых изменение скорости a = target − C влезает в эллипс с
 * полуосями drive (клетки/ход):
 *  - продольно вперёд (a·û ≥ 0) — полуось accel; назад (торможение) — полуось brake;
 *  - поперечно (вбок) — полуось maneuver;
 *  - условие эллипса (a_along/cap)² + (a_lat/maneuver)² ≤ 1 связывает разгон и доворот:
 *    разгоняешься в пол — на доворот не осталось, и наоборот (скруглённые углы).
 * Скорость учитывается сама: доворот на угол θ требует поперечного Δv ≈ |vel|·θ, значит
 * θ_max ≈ maneuver/|vel| — чем быстрее, тем меньше доворот за ход. Точка наката (a = 0)
 * всегда в наборе (0 ≤ 1), так что инерция/пропуск работают как в классике.
 *
 * На старте (vel = 0) направления нет: изотропный диск радиуса max(accel, MIN_LAUNCH).
 * Пол MIN_LAUNCH = √2 гарантирует диагональный старт (набор 3×3) при любом разгоне.
 * Все три полуоси равны → изотропный круг: grip в [√2, 2) даёт ровно квадрат 3×3
 * (классика).
 */
export function reachableTargets(pos: Vec, vel: Vec, drive: Drive): Vec[] {
  const { accel, brake, maneuver } = drive;
  const cx = pos.x + vel.x;
  const cy = pos.y + vel.y;
  const speed = Math.hypot(vel.x, vel.y);
  const r = Math.ceil(Math.max(accel, brake, maneuver, MIN_LAUNCH)); // рамка перебора узлов
  const EPS = 1e-9;
  const out: Vec[] = [];
  for (let ay = -r; ay <= r; ay++) {
    for (let ax = -r; ax <= r; ax++) {
      if (speed === 0) {
        const rad = Math.max(accel, MIN_LAUNCH); // старт: диагональ доступна всем
        if (ax * ax + ay * ay > rad * rad + EPS) continue;
      } else {
        const ux = vel.x / speed;
        const uy = vel.y / speed;
        const along = ax * ux + ay * uy; // продольная составляющая a (вдоль скорости)
        const lat = -ax * uy + ay * ux; // поперечная составляющая a (вбок)
        const cap = along >= 0 ? accel : brake; // перёд — разгон, зад — тормоза
        const nl = cap === 0 ? (along === 0 ? 0 : Infinity) : along / cap;
        const nt = maneuver === 0 ? (lat === 0 ? 0 : Infinity) : lat / maneuver;
        if (nl * nl + nt * nt > 1 + EPS) continue; // вне эллипса сцепления
      }
      out.push({ x: cx + ax, y: cy + ay });
    }
  }
  return out;
}

/**
 * Ходы-кандидаты произвольного места `seat` от его текущих pos/vel. Вынесено из
 * candidates(), чтобы считать веер не только для ходящего игрока: онлайн/vs-боты
 * показывают его для своего места ещё до наступления хода (предвыбор — «наметка»).
 */
export function candidatesForSeat(state: GameState, seat: number): Candidate[] {
  const p = state.players[seat];
  const occupied = otherPositions(state, seat);
  const cx = p.pos.x + p.vel.x; // точка наката C (чистая инерция, a = 0)
  const cy = p.pos.y + p.vel.y;
  const targets = reachableTargets(p.pos, p.vel, state.rules.drive);
  return targets.map((target) => ({
    target,
    // Ход запрещён, если соперник стоит в конечной точке или отрезок хода проходит
    // через клетку, где соперник стоит сейчас (проехать «сквозь» нельзя).
    blocked: occupied.some((o) => pointOnSegment(o, p.pos, target)),
    crash: computeOutcome(state.track, state.rules, p.pos, target).crash,
    inertial: target.x === cx && target.y === cy,
  }));
}

export function candidates(state: GameState): Candidate[] {
  return candidatesForSeat(state, state.current);
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
 * turn % n, номер круга (round) — floor(turn / n). Игроки ходят по кругу: стартовый
 * сдвигается на round — (round + seat) % n. n=3: круг 1 — 0,1,2; круг 2 — 1,2,0;
 * круг 3 — 2,0,1 (без преимущества первого хода). Это перестановка всех игроков в
 * каждом круге (никто не пропущен и не ходит дважды) и детерминирована: одинаковый
 * turn у всех клиентов даёт один индекс.
 */
export function playerForTurn(turn: number, n: number): number {
  const round = Math.floor(turn / n);
  const seat = turn % n;
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
    const seat = playerForTurn(turn, n);
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
 * Смена хода и учёт финиша. Игроки ходят по кругу; очерёдность внутри круга
 * задаёт playerForTurn (стартовый сдвигается каждый круг). Как только кто-то
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
  state.current = playerForTurn(state.turn, n);
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
