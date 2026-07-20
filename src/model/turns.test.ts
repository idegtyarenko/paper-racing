import { describe, it, expect } from 'vitest';
import { newGame, cloneState, Candidate, Player, DEFAULT_RULES } from './game';
import {
  candidates,
  candidatesForSeat,
  applyMove,
  coastMove,
  playerForTurn,
  upcomingTurns,
  retireSeat,
  reachableTargets,
} from './turns';
import { WIN_CROSSINGS, DRIVE_PRESETS } from '../config';
import { key } from './track';
import { ringTrack } from './test-fixtures';

const cand = (x: number, y: number): Candidate => ({
  target: { x, y },
  crash: false,
  blocked: false,
  inertial: false,
});

/** Ставит игрока в известную точку дороги с заданной скоростью. */
function place(p: Player, pos: [number, number], vel: [number, number] = [0, 0]): void {
  p.pos = { x: pos[0], y: pos[1] };
  p.vel = { x: vel[0], y: vel[1] };
}

describe('candidates', () => {
  // Классическая управляемость (изотропный квадрат 3×3) — явно, т.к. дефолт
  // теперь реалистичный (эллипс сцепления).
  const classicGame = () =>
    newGame(ringTrack(), 2, { ...DEFAULT_RULES, drive: { ...DRIVE_PRESETS.classic } });

  it('9 кандидатов, ровно один инерционный с target = pos + vel', () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [2, 1]);
    const cs = candidates(g);
    expect(cs).toHaveLength(9);
    const inertial = cs.filter((c) => c.inertial);
    expect(inertial).toHaveLength(1);
    expect(inertial[0].target).toEqual({ x: 12, y: 5 });
  });

  it('crash отмечен, когда ход выходит за стенку глубже допуска', () => {
    const g = classicGame();
    place(g.players[0], [10, 2], [0, -2]); // база (10,0), нижняя строка целей уходит за y=0
    const cs = candidates(g);
    const belowWall = cs.filter((c) => c.target.y === -1);
    expect(belowWall).toHaveLength(3);
    expect(belowWall.every((c) => c.crash)).toBe(true);
    expect(cs.filter((c) => c.target.y === 1).every((c) => !c.crash)).toBe(true);
  });

  it('blocked, когда соперник стоит в целевой точке', () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [2, 0]);
    place(g.players[1], [13, 4]); // цель (13,4) при ускорении (1,0)
    const c = candidates(g).find((c) => c.target.x === 13 && c.target.y === 4)!;
    expect(c.blocked).toBe(true);
  });

  it('blocked, когда соперник стоит на пути хода (проезд «сквозь» запрещён)', () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [2, 0]);
    place(g.players[1], [11, 4]); // на отрезке (10,4)→(12,4)
    const inertial = candidates(g).find((c) => c.inertial)!;
    expect(inertial.target).toEqual({ x: 12, y: 4 });
    expect(inertial.blocked).toBe(true);
  });

  it('соперник, отбывающий штраф (skipTurns>0), не блокирует', () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [2, 0]);
    place(g.players[1], [11, 4]);
    g.players[1].skipTurns = 1;
    const inertial = candidates(g).find((c) => c.inertial)!;
    expect(inertial.blocked).toBe(false);
  });

  it('на старте (vel = 0) классика даёт квадрат 3×3 с диагоналями', () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [0, 0]);
    const cs = candidates(g);
    expect(cs).toHaveLength(9);
    // диагональ доступна
    expect(cs.some((c) => c.target.x === 11 && c.target.y === 5)).toBe(true);
  });
});

describe('candidatesForSeat — веер не-ходящего места (предвыбор)', () => {
  const classicGame = () =>
    newGame(ringTrack(), 2, { ...DEFAULT_RULES, drive: { ...DRIVE_PRESETS.classic } });

  it('считает от pos/vel указанного места, а не текущего', () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [0, 0]); // current, но нас интересует место 1
    place(g.players[1], [20, 6], [2, 1]);
    const cs = candidatesForSeat(g, 1);
    expect(cs).toHaveLength(9);
    const inertial = cs.filter((c) => c.inertial);
    expect(inertial).toHaveLength(1);
    expect(inertial[0].target).toEqual({ x: 22, y: 7 }); // pos + vel места 1
  });

  it('blocked учитывает чужие позиции (текущего игрока на пути)', () => {
    const g = classicGame();
    place(g.players[1], [10, 4], [2, 0]);
    place(g.players[0], [11, 4]); // соперник (текущий) на отрезке (10,4)→(12,4)
    const inertial = candidatesForSeat(g, 1).find((c) => c.inertial)!;
    expect(inertial.target).toEqual({ x: 12, y: 4 });
    expect(inertial.blocked).toBe(true);
  });

  it('candidates(state) эквивалентен candidatesForSeat(state, current)', () => {
    const g = classicGame();
    place(g.players[0], [10, 4], [1, -1]);
    expect(candidatesForSeat(g, g.current)).toEqual(candidates(g));
  });
});

describe('candidates — реалистичная физика (эллипс сцепления)', () => {
  const D = DRIVE_PRESETS.sports; // downforce 0 → aero = 1, эллипс чисто механический
  /** Игра с реалистичной управляемостью. */
  const realGame = () => newGame(ringTrack(), 2, { ...DEFAULT_RULES, drive: { ...D } });
  /** Ускорение кандидата a = target − (pos + vel). */
  const accelOf = (c: Candidate, p: Player) => ({
    x: c.target.x - p.pos.x - p.vel.x,
    y: c.target.y - p.pos.y - p.vel.y,
  });
  /** Внутри ли ускорение a эллипса сцепления при скорости vel. */
  function inEllipse(
    a: { x: number; y: number },
    vel: { x: number; y: number },
  ): boolean {
    const speed = Math.hypot(vel.x, vel.y);
    const ux = vel.x / speed;
    const uy = vel.y / speed;
    const along = a.x * ux + a.y * uy;
    const lat = -a.x * uy + a.y * ux;
    const cap = along >= 0 ? D.accel : D.brake;
    return (along / cap) ** 2 + (lat / D.grip) ** 2 <= 1 + 1e-9;
  }
  /** Максимальный доворот (угол между старой и новой скоростью) среди кандидатов. */
  function maxTurn(g: ReturnType<typeof realGame>): number {
    const p = g.players[0];
    let max = 0;
    for (const c of candidates(g)) {
      const nv = { x: c.target.x - p.pos.x, y: c.target.y - p.pos.y };
      if (nv.x === 0 && nv.y === 0) continue;
      const cross = p.vel.x * nv.y - p.vel.y * nv.x;
      const dot = p.vel.x * nv.x + p.vel.y * nv.y;
      max = Math.max(max, Math.abs(Math.atan2(cross, dot)));
    }
    return max;
  }

  it('цели целочисленны и внутри эллипса сцепления, ровно один инерционный', () => {
    const g = realGame();
    place(g.players[0], [10, 4], [3, 0]);
    const p = g.players[0];
    const cs = candidates(g);
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.filter((c) => c.inertial)).toHaveLength(1);
    for (const c of cs) {
      expect(Number.isInteger(c.target.x)).toBe(true);
      expect(Number.isInteger(c.target.y)).toBe(true);
      expect(inEllipse(accelOf(c, p), p.vel)).toBe(true);
    }
  });

  it('инерционный кандидат = точка наката pos + vel (a = 0)', () => {
    const g = realGame();
    place(g.players[0], [10, 4], [2, 1]);
    const inertial = candidates(g).find((c) => c.inertial)!;
    expect(inertial.target).toEqual({ x: 12, y: 5 });
  });

  it('на старте (vel = 0) доступен диагональный ход — набор 3×3', () => {
    const g = realGame();
    place(g.players[0], [10, 4], [0, 0]);
    const targets = candidates(g)
      .map((c) => `${c.target.x},${c.target.y}`)
      .sort();
    const expected: string[] = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) expected.push(`${10 + dx},${4 + dy}`);
    expect(targets).toEqual(expected.sort());
  });

  it('тормозит быстрее, чем разгоняется: назад дотягивается дальше вперёд', () => {
    expect(D.accel).toBeLessThan(D.brake); // предпосылка асимметрии
    const g = realGame();
    place(g.players[0], [10, 4], [3, 0]); // едет вправо, продольная ось = x
    const p = g.players[0];
    const speeds = candidates(g).map((c) => c.target.x - p.pos.x); // новая скорость по ходу
    const base = p.vel.x;
    expect(Math.max(...speeds) - base).toBe(D.accel); // вперёд — ровно потолок разгона
    expect(base - Math.min(...speeds)).toBe(D.brake); // назад — ровно тормоза
  });

  it('чем выше скорость, тем меньше максимальный доворот за ход', () => {
    const slow = realGame();
    place(slow.players[0], [10, 4], [2, 0]);
    const fast = realGame();
    place(fast.players[0], [10, 4], [5, 0]);
    expect(maxTurn(fast)).toBeLessThan(maxTurn(slow));
  });
});

describe('reachableTargets — аэродинамический прижим (downforce)', () => {
  const pos = { x: 0, y: 0 };
  const noAero = { accel: 1, brake: 2, grip: 2, downforce: 0 };
  const withAero = { ...noAero, downforce: 1 };
  const keys = (vel: { x: number; y: number }, d: typeof noAero) =>
    reachableTargets(pos, vel, d).map((t) => `${t.x},${t.y}`);

  it('на скорости прижим только расширяет область: старые узлы остаются, есть новые', () => {
    const vel = { x: 4, y: 0 }; // референсная скорость: aero = 1 + 1·(4/4)² = 2
    const base = new Set(keys(vel, noAero));
    const boosted = new Set(keys(vel, withAero));
    for (const k of base) expect(boosted.has(k)).toBe(true); // прижим только добавляет хват
    expect(boosted.size).toBeGreaterThan(base.size); // строго шире
  });

  it('на нулевой скорости прижим ничего не меняет (aero = 1)', () => {
    const vel = { x: 0, y: 0 };
    expect(keys(vel, withAero).sort()).toEqual(keys(vel, noAero).sort());
  });
});

describe('applyMove — обычный ход', () => {
  it('обновляет pos, vel и добавляет след; передаёт ход', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 4], [1, 0]);
    applyMove(g, cand(11, 4));
    const p = g.players[0];
    expect(p.pos).toEqual({ x: 11, y: 4 });
    expect(p.vel).toEqual({ x: 1, y: 0 });
    expect(p.trail).toHaveLength(1);
    expect(p.trail[0]).toMatchObject({ jump: false });
    expect(g.current).toBe(1);
  });

  it('blocked-кандидат — no-op', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 4]);
    const before = JSON.stringify(g.players[0]);
    applyMove(g, { ...cand(11, 4), blocked: true });
    expect(JSON.stringify(g.players[0])).toBe(before);
    expect(g.current).toBe(0); // ход не ушёл
  });

  it('в фазе over — no-op', () => {
    const g = newGame(ringTrack(), 2);
    g.phase = 'over';
    place(g.players[0], [10, 4]);
    applyMove(g, cand(11, 4));
    expect(g.players[0].pos).toEqual({ x: 10, y: 4 });
  });
});

describe('applyMove — авария', () => {
  it('болид остаётся в гравии, скорость обнуляется, назначается штраф, но НЕ телепортируется на трассу', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 1]);
    applyMove(g, cand(10, -2)); // сквозь нижнюю стенку y=0; длина хода 3
    const p = g.players[0];
    expect(p.pos.x).toBeCloseTo(10);
    expect(p.pos.y).toBeLessThan(0); // застрял на кромке допуска, не на inside
    expect(p.pos.y).toBeGreaterThan(-1);
    expect(p.vel).toEqual({ x: 0, y: 0 });
    expect(p.crashes).toHaveLength(1);
    expect(p.skipTurns).toBe(3); // crashPenalty(dynamic 1, speed 3) = 3
    expect(p.trail[0].jump).toBe(false);
  });
});

describe('applyMove — пересечение финиша', () => {
  it('ход через линию вперёд засчитывает +1', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [5, 4]); // позади (x<6)
    applyMove(g, cand(7, 4)); // за линию (x>6)
    expect(g.players[0].crossings).toBe(1);
  });

  it('ход назад через линию засчитывает −1', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [7, 4]);
    g.players[0].crossings = 1;
    applyMove(g, cand(5, 4));
    expect(g.players[0].crossings).toBe(0);
  });

  it('ход, не пересекающий линию, счётчик не меняет', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [7, 4]);
    applyMove(g, cand(9, 4));
    expect(g.players[0].crossings).toBe(0);
  });
});

describe('порядок ходов и отбытие штрафа', () => {
  it('вылетевший болид возвращается на трассу ТОЛЬКО когда штраф отбыт до нуля', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 1]);
    applyMove(g, cand(10, -2)); // p0 в гравии, skip=3, ход у соперника
    const crashed = g.players[0];
    const gravel = { ...crashed.pos };
    expect(crashed.skipTurns).toBe(3);
    expect(g.current).toBe(1);

    // Гоняем ходы: пока штраф не отбыт, ход всегда у не-вылетевшего игрока
    // (пропуски p0 сгорают автоматически внутри afterAction). Инвариант: пока
    // skip>0, вылетевший остаётся в гравии; на нуле — возвращается на трассу.
    let guard = 0;
    while (crashed.skipTurns > 0 && guard++ < 20) {
      expect(g.current).not.toBe(0); // p0 отбывает — ходит соперник
      place(g.players[g.current], [20, 4], [0, 0]);
      applyMove(g, cand(20, 4));
      if (crashed.skipTurns > 0) expect(crashed.pos).toEqual(gravel);
    }
    expect(crashed.skipTurns).toBe(0);
    // после отбытия — на узле дороги (inside), с пунктирным «телепортом».
    expect(g.track.inside.has(key(crashed.pos.x, crashed.pos.y))).toBe(true);
    expect(crashed.trail.some((s) => s.jump)).toBe(true);
  });
});

describe('честная очерёдность хода', () => {
  it('стартовый игрок сдвигается каждый круг: А,Б,В → Б,В,А → В,А,Б', () => {
    const order = (turn: number) => playerForTurn(turn, 3);
    expect([0, 1, 2].map(order)).toEqual([0, 1, 2]); // круг 1
    expect([3, 4, 5].map(order)).toEqual([1, 2, 0]); // круг 2
    expect([6, 7, 8].map(order)).toEqual([2, 0, 1]); // круг 3
    expect([9, 10, 11].map(order)).toEqual([0, 1, 2]); // цикл замкнулся
  });

  it('каждый круг — перестановка всех игроков (никто не пропущен и не сходит дважды)', () => {
    for (let n = 2; n <= 6; n++) {
      for (let round = 0; round < 4; round++) {
        const seats = Array.from({ length: n }, (_, s) =>
          playerForTurn(round * n + s, n),
        );
        expect([...seats].sort((a, b) => a - b)).toEqual(
          Array.from({ length: n }, (_, i) => i),
        );
      }
    }
  });

  it('реальные ходы в игре идут по ротации (3 игрока, два круга)', () => {
    const g = newGame(ringTrack(), 3);
    // Разводим болиды по разным клеткам нижнего коридора (y∈1..7), чтобы ходы
    // не блокировали друг друга.
    g.players.forEach((p, i) => place(p, [20, 2 + i * 2], [0, 0]));
    const seen: number[] = [];
    for (let k = 0; k < 6; k++) {
      seen.push(g.current);
      const cur = g.players[g.current];
      place(cur, [10 + k, 3], [0, 0]); // уникальная свободная клетка на этот ход
      applyMove(g, cand(10 + k, 3));
    }
    expect(seen).toEqual([0, 1, 2, 1, 2, 0]);
  });
});

describe('upcomingTurns — очередь ближайших ходов', () => {
  it('первый элемент — текущий игрок; порядок следует ротации', () => {
    const g = newGame(ringTrack(), 3);
    expect(upcomingTurns(g, 6)).toEqual([0, 1, 2, 1, 2, 0]); // как реальные ходы
  });

  it('смотрит вперёд от текущего слота (turn != 0)', () => {
    const g = newGame(ringTrack(), 3);
    g.turn = 4;
    g.current = playerForTurn(4, 3); // держим инвариант current == playerForTurn(turn)
    expect(upcomingTurns(g, 4)).toEqual([2, 0, 2, 0]); // слоты 4,5,6,7 = 2,0,2,0
  });

  it('игрок в боксах (skipTurns) не появляется, пока не отбудет штраф', () => {
    const g = newGame(ringTrack(), 3);
    g.players[1].skipTurns = 2; // Синий отбывает два хода
    // Слоты rotate: 0,1,2,0(круг2 сдвиг:1,2,0)… Синий (1) в слотах 1 и 3 сгорают.
    const q = upcomingTurns(g, 5);
    expect(q[0]).toBe(0);
    expect(q).not.toContain(1); // за первые пять реальных ходов Синий ещё в гравии/только вышел
    // после отбытия штрафа Синий возвращается в очередь
    expect(upcomingTurns(g, 8)).toContain(1);
  });

  it('решающий круг: очередь не длиннее оставшихся слотов (finalTurnsLeft)', () => {
    const g = newGame(ringTrack(), 3);
    g.finalTurnsLeft = 2;
    expect(upcomingTurns(g, 9)).toHaveLength(2);
  });

  it('решающий круг: слот игрока в боксах тратит остаток и укорачивает очередь', () => {
    const g = newGame(ringTrack(), 3);
    g.finalTurnsLeft = 2;
    g.players[1].skipTurns = 1; // Синий (слот 1) отбывает штраф — его слот сгорает
    // Слоты 0,1: слот0 → Красный ходит (остаётся 1), слот1 → Синий пропуск (остаётся 0).
    expect(upcomingTurns(g, 9)).toEqual([0]);
  });

  it('детерминирован: не мутирует стейт', () => {
    const g = newGame(ringTrack(), 3);
    g.players[1].skipTurns = 2;
    const before = JSON.stringify(g);
    upcomingTurns(g, 12);
    expect(JSON.stringify(g)).toBe(before);
  });
});

describe('многораундовый финиш, места и сдача', () => {
  it('первый финишировавший получает место 1 и звание победителя, но гонка продолжается', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [5, 4]);
    g.players[0].crossings = WIN_CROSSINGS - 1; // финиширует этим ходом
    applyMove(g, cand(7, 4)); // crossings → WIN, overshoot = 1
    expect(g.players[0].crossings).toBe(WIN_CROSSINGS);
    expect(g.finalTurnsLeft).toBe(1); // раунд открыт: остался ход второго
    expect(g.phase).toBe('race');

    place(g.players[1], [10, 4]);
    applyMove(g, cand(13, 4)); // p1 не финишировал — раунд разрешается
    expect(g.players[0].place).toBe(1);
    expect(g.winner).toBe(0);
    expect(g.players[1].place).toBeNull();
    expect(g.phase).toBe('race'); // гонка идёт, пока p1 не финиширует/сдастся
  });

  it('места в одном раунде — по глубине заезда, а не по очереди хода', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [5, 4]);
    g.players[0].crossings = WIN_CROSSINGS - 1;
    applyMove(g, cand(7, 4)); // p0 ходит первым, overshoot 1
    place(g.players[1], [5, 4]);
    g.players[1].crossings = WIN_CROSSINGS - 1;
    applyMove(g, cand(9, 4)); // p1 заехал глубже, overshoot 3
    expect(g.phase).toBe('over');
    expect(g.players[1].place).toBe(1); // глубже за линию → выше место
    expect(g.players[0].place).toBe(2);
    expect(g.winner).toBe(1);
  });

  it('равный заезд в раунде делит место (1224): два вторых → следующий четвёртый', () => {
    const g = newGame(ringTrack(), 4);
    [0, 1, 2, 3].forEach((i) => {
      place(g.players[i], [5, 4]);
      g.players[i].crossings = WIN_CROSSINGS - 1;
    });
    applyMove(g, cand(11, 4)); // p0 overshoot 5 → место 1
    applyMove(g, cand(9, 4)); // p1 overshoot 3
    applyMove(g, cand(9, 4)); // p2 overshoot 3 (равно p1)
    applyMove(g, cand(7, 4)); // p3 overshoot 1
    expect(g.phase).toBe('over');
    expect(g.players.map((p) => p.place)).toEqual([1, 2, 2, 4]);
    expect(g.winner).toBe(0);
  });

  it('делёж 1-го места в раунде → winner draw', () => {
    const g = newGame(ringTrack(), 2);
    [0, 1].forEach((i) => {
      place(g.players[i], [5, 4]);
      g.players[i].crossings = WIN_CROSSINGS - 1;
    });
    applyMove(g, cand(7, 4)); // p0 overshoot 1
    applyMove(g, cand(7, 4)); // p1 overshoot 1 — равны
    expect(g.phase).toBe('over');
    expect(g.players[0].place).toBe(1);
    expect(g.players[1].place).toBe(1);
    expect(g.winner).toBe('draw');
  });

  it('сдача: игрок выбывает, ход уходит дальше, в очереди не появляется', () => {
    const g = newGame(ringTrack(), 3);
    expect(g.current).toBe(0);
    retireSeat(g, g.current);
    expect(g.players[0].retired).toBe(true);
    expect(g.players[0].place).toBeNull();
    expect(g.phase).toBe('race');
    expect(g.current).not.toBe(0); // ход перешёл дальше
    expect(upcomingTurns(g, 6)).not.toContain(0);
  });

  it('сдача не своего болида (в любой момент) не двигает очередь, но убирает его', () => {
    const g = newGame(ringTrack(), 3);
    expect(g.current).toBe(0);
    retireSeat(g, 2); // сдаётся не ходящий сейчас игрок
    expect(g.players[2].retired).toBe(true);
    expect(g.current).toBe(0); // ход остался у текущего
    expect(g.phase).toBe('race');
    expect(upcomingTurns(g, 6)).not.toContain(2);
  });

  it('все сдались → гонка окончена без победителя', () => {
    const g = newGame(ringTrack(), 2);
    retireSeat(g, g.current); // p0
    retireSeat(g, g.current); // p1 — активных не осталось
    expect(g.phase).toBe('over');
    expect(g.winner).toBeNull();
  });

  it('после чужого финиша оставшийся может сдаться — гонка завершается, победитель сохранён', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [5, 4]);
    g.players[0].crossings = WIN_CROSSINGS - 1;
    applyMove(g, cand(7, 4)); // p0 финиширует, раунд открыт
    place(g.players[1], [10, 4]);
    applyMove(g, cand(13, 4)); // p1 без финиша → p0 место 1, winner 0, гонка идёт
    expect(g.winner).toBe(0);
    expect(g.phase).toBe('race');
    expect(g.current).toBe(1); // p0 выбыл — ход у p1
    retireSeat(g, g.current); // p1 сдаётся — активных не осталось
    expect(g.phase).toBe('over');
    expect(g.players[1].retired).toBe(true);
    expect(g.winner).toBe(0); // победитель не переопределяется
  });
});

describe('coastMove', () => {
  it('стоящий болид (vel 0) просто пасует, без вырожденного следа', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 4], [0, 0]);
    coastMove(g);
    expect(g.players[0].trail).toHaveLength(0);
    expect(g.current).toBe(1);
  });

  it('едущий болид продолжает по инерции (pos += vel)', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 4], [2, 0]);
    coastMove(g);
    expect(g.players[0].pos).toEqual({ x: 12, y: 4 });
  });

  it('инерционная клетка занята → скорость обнуляется, ход уходит', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 4], [2, 0]);
    place(g.players[1], [12, 4]); // инерционная цель занята
    coastMove(g);
    expect(g.players[0].pos).toEqual({ x: 10, y: 4 }); // остался на месте
    expect(g.players[0].vel).toEqual({ x: 0, y: 0 });
    expect(g.current).toBe(1);
  });

  it('детерминирован: две копии одного стейта дают идентичный результат', () => {
    const base = newGame(ringTrack(), 2);
    place(base.players[0], [10, 4], [1, 1]);
    const a = cloneState(base);
    const b = cloneState(base);
    coastMove(a);
    coastMove(b);
    expect(JSON.stringify(a.players)).toBe(JSON.stringify(b.players));
  });
});
