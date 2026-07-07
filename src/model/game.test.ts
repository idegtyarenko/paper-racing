import { describe, it, expect } from 'vitest';
import {
  Rules,
  DEFAULT_RULES,
  crashPenalty,
  newGame,
  cloneState,
  candidates,
  applyMove,
  coastMove,
  Candidate,
  Player,
} from './game';
import { CRASH_PENALTY_MAX, WIN_CROSSINGS } from '../config';
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

describe('crashPenalty', () => {
  const dyn = (exp: number): Rules => ({
    ...DEFAULT_RULES,
    penalty: 'dynamic',
    dynamicExponent: exp,
  });

  it('статический штраф — фиксированное число ходов, не зависит от скорости', () => {
    const rules: Rules = { ...DEFAULT_RULES, penalty: 'static', staticTurns: 4 };
    expect(crashPenalty(rules, 1)).toBe(4);
    expect(crashPenalty(rules, 7)).toBe(4);
  });

  it('динамический (строгость 1) — round(speed), зажатый в [1, MAX]', () => {
    expect(crashPenalty(dyn(1), 0.5)).toBe(1);
    expect(crashPenalty(dyn(1), 2)).toBe(2);
    expect(crashPenalty(dyn(1), 3)).toBe(3);
    expect(crashPenalty(dyn(1), 100)).toBe(CRASH_PENALTY_MAX);
  });

  it('динамический (строгость 1.5) — круче для быстрых вылетов', () => {
    expect(crashPenalty(dyn(1.5), 1)).toBe(1);
    expect(crashPenalty(dyn(1.5), 2)).toBe(3);
    expect(crashPenalty(dyn(1.5), 3)).toBe(5);
    expect(crashPenalty(dyn(1.5), 4)).toBe(CRASH_PENALTY_MAX); // 4^1.5 = 8
  });
});

describe('candidates', () => {
  it('9 кандидатов, ровно один инерционный с target = pos + vel', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 4], [2, 1]);
    const cs = candidates(g);
    expect(cs).toHaveLength(9);
    const inertial = cs.filter((c) => c.inertial);
    expect(inertial).toHaveLength(1);
    expect(inertial[0].target).toEqual({ x: 12, y: 5 });
  });

  it('crash отмечен, когда ход выходит за стенку глубже допуска', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 2], [0, -2]); // база (10,0), нижняя строка целей уходит за y=0
    const cs = candidates(g);
    const belowWall = cs.filter((c) => c.target.y === -1);
    expect(belowWall).toHaveLength(3);
    expect(belowWall.every((c) => c.crash)).toBe(true);
    expect(cs.filter((c) => c.target.y === 1).every((c) => !c.crash)).toBe(true);
  });

  it('blocked, когда соперник стоит в целевой точке', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 4], [2, 0]);
    place(g.players[1], [13, 4]); // цель (13,4) при ускорении (1,0)
    const c = candidates(g).find((c) => c.target.x === 13 && c.target.y === 4)!;
    expect(c.blocked).toBe(true);
  });

  it('blocked, когда соперник стоит на пути хода (проезд «сквозь» запрещён)', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 4], [2, 0]);
    place(g.players[1], [11, 4]); // на отрезке (10,4)→(12,4)
    const inertial = candidates(g).find((c) => c.inertial)!;
    expect(inertial.target).toEqual({ x: 12, y: 4 });
    expect(inertial.blocked).toBe(true);
  });

  it('соперник, отбывающий штраф (skipTurns>0), не блокирует', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [10, 4], [2, 0]);
    place(g.players[1], [11, 4]);
    g.players[1].skipTurns = 1;
    const inertial = candidates(g).find((c) => c.inertial)!;
    expect(inertial.blocked).toBe(false);
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
    applyMove(g, cand(10, -2)); // p0 в гравии, skip=3, ход у p1
    const crashed = g.players[0];
    const gravel = { ...crashed.pos };
    expect(crashed.skipTurns).toBe(3);
    expect(g.current).toBe(1);

    const skipsSeen: number[] = [];
    // p1 делает три обычных хода; между ними p0 сжигает по одному пропуску.
    for (let k = 0; k < 3; k++) {
      place(g.players[1], [20, 4], [0, 0]);
      applyMove(g, cand(20, 4));
      skipsSeen.push(crashed.skipTurns);
      if (crashed.skipTurns > 0) {
        // ещё отбывает — остаётся в гравии
        expect(crashed.pos).toEqual(gravel);
      }
    }
    expect(skipsSeen).toEqual([2, 1, 0]);
    // после отбытия — на узле дороги (inside), с пунктирным «телепортом».
    expect(g.track.inside.has(key(crashed.pos.x, crashed.pos.y))).toBe(true);
    expect(crashed.trail.some((s) => s.jump)).toBe(true);
  });
});

describe('решающий круг и определение победителя', () => {
  it('первый финишировавший запускает доигровку; далее победитель — по глубине заезда', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [5, 4]);
    g.players[0].crossings = WIN_CROSSINGS - 1; // финиширует этим ходом
    applyMove(g, cand(7, 4)); // crossings → WIN, overshoot = 1
    expect(g.players[0].crossings).toBe(WIN_CROSSINGS);
    expect(g.finalTurnsLeft).toBe(1); // остался ход второго игрока
    expect(g.phase).toBe('race');

    place(g.players[1], [10, 4]);
    applyMove(g, cand(12, 4)); // p1 не финишировал
    expect(g.phase).toBe('over');
    expect(g.winner).toBe(0);
  });

  it('равная глубина заезда финишировавших → ничья', () => {
    const g = newGame(ringTrack(), 2);
    place(g.players[0], [5, 4]);
    g.players[0].crossings = WIN_CROSSINGS - 1;
    applyMove(g, cand(7, 4)); // overshoot 1, finalTurnsLeft = 1

    place(g.players[1], [5, 4]);
    g.players[1].crossings = WIN_CROSSINGS - 1;
    applyMove(g, cand(7, 4)); // тоже overshoot 1
    expect(g.phase).toBe('over');
    expect(g.winner).toBe('draw');
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

describe('cloneState', () => {
  it('глубоко независим по игрокам, но track — по ссылке', () => {
    const g = newGame(ringTrack(), 2);
    const c = cloneState(g);
    c.players[0].pos.x = 999;
    expect(g.players[0].pos.x).not.toBe(999);
    expect(c.track).toBe(g.track);
  });
});
