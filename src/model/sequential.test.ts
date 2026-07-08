import { describe, it, expect } from 'vitest';
import { newGame, cloneState, Candidate, Player } from './game';
import { candidates, applyMove, coastMove, playerForTurn } from './sequential';
import { WIN_CROSSINGS } from '../config';
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
  it("'rotate' — стартовый игрок сдвигается каждый круг: А,Б,В → Б,В,А → В,А,Б", () => {
    const order = (turn: number) => playerForTurn(turn, 3, 'rotate');
    expect([0, 1, 2].map(order)).toEqual([0, 1, 2]); // круг 1
    expect([3, 4, 5].map(order)).toEqual([1, 2, 0]); // круг 2
    expect([6, 7, 8].map(order)).toEqual([2, 0, 1]); // круг 3
    expect([9, 10, 11].map(order)).toEqual([0, 1, 2]); // цикл замкнулся
  });

  it("'snake' — направление задаётся последовательностью Тьюе-Морса: abc cba cba abc cba abc abc cba", () => {
    const order = (turn: number) => playerForTurn(turn, 3, 'snake');
    expect([0, 1, 2].map(order)).toEqual([0, 1, 2]); // круг 1
    expect([3, 4, 5].map(order)).toEqual([2, 1, 0]); // круг 2
    expect([6, 7, 8].map(order)).toEqual([2, 1, 0]); // круг 3
    expect([9, 10, 11].map(order)).toEqual([0, 1, 2]); // круг 4
    expect([12, 13, 14].map(order)).toEqual([2, 1, 0]); // круг 5
    expect([15, 16, 17].map(order)).toEqual([0, 1, 2]); // круг 6
    expect([18, 19, 20].map(order)).toEqual([0, 1, 2]); // круг 7
    expect([21, 22, 23].map(order)).toEqual([2, 1, 0]); // круг 8
  });

  it("'fixed' — очерёдность не меняется: А,Б,В каждый круг", () => {
    const order = (turn: number) => playerForTurn(turn, 3, 'fixed');
    expect([0, 1, 2].map(order)).toEqual([0, 1, 2]);
    expect([3, 4, 5].map(order)).toEqual([0, 1, 2]);
    expect([6, 7, 8].map(order)).toEqual([0, 1, 2]);
  });

  it('любая схема — перестановка всех игроков в круге (никто не пропущен и не сходит дважды)', () => {
    for (const scheme of ['rotate', 'snake', 'fixed'] as const) {
      for (let n = 2; n <= 6; n++) {
        for (let round = 0; round < 4; round++) {
          const seats = Array.from({ length: n }, (_, s) =>
            playerForTurn(round * n + s, n, scheme),
          );
          expect([...seats].sort((a, b) => a - b)).toEqual(
            Array.from({ length: n }, (_, i) => i),
          );
        }
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
