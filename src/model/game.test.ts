import { describe, it, expect } from 'vitest';
import {
  Rules,
  DEFAULT_RULES,
  crashPenalty,
  newGame,
  cloneState,
  returnFromPenalty,
  WIN_CROSSINGS,
} from './game';
import { CRASH_PENALTY_MAX } from '../config';
import { ringTrack } from './test-fixtures';

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

describe('returnFromPenalty — пересечение финиша телепортом возврата', () => {
  // Финиш фикстуры — линия x=6, гонка в +x; sideOfFinish(p) = p.x − 6. Соперники
  // на (4,1)/(5,1)/(6,1) заняли клетки позади и на линии, поэтому ближайшая
  // свободная к точке аварии (5.5, 0.4) — узел (7,1) уже ЗА линией: возврат
  // перепрыгивает финиш.
  function crashedBehindFinish(crossings: number) {
    const g = newGame(ringTrack(), 4);
    g.players[1].pos = { x: 4, y: 1 };
    g.players[2].pos = { x: 5, y: 1 };
    g.players[3].pos = { x: 6, y: 1 };
    g.players[0].pos = { x: 5.5, y: 0.4 }; // в гравии позади линии (x<6)
    g.players[0].crossings = crossings;
    return g;
  }

  it('возврат за линию засчитывает круг (+1 к crossings)', () => {
    const g = crashedBehindFinish(0);
    returnFromPenalty(g, 0);
    expect(g.players[0].pos).toEqual({ x: 7, y: 1 }); // за линией
    expect(g.players[0].crossings).toBe(1);
  });

  it('возврат на ту же сторону линии счётчик не трогает', () => {
    const g = newGame(ringTrack(), 2);
    g.players[1].pos = { x: 20, y: 10 }; // не мешает
    g.players[0].pos = { x: 5.4, y: 0.3 }; // ближайшая свободная — (5,1), тоже позади
    g.players[0].crossings = 0;
    returnFromPenalty(g, 0);
    expect(g.players[0].pos.x).toBeLessThan(6); // остался позади линии
    expect(g.players[0].crossings).toBe(0);
  });

  it('возврат, добивающий победный круг, проставляет finishOvershoot', () => {
    const g = crashedBehindFinish(WIN_CROSSINGS - 1);
    returnFromPenalty(g, 0);
    expect(g.players[0].crossings).toBe(WIN_CROSSINGS);
    expect(g.players[0].finishOvershoot).toBe(1); // sideOfFinish(7,1) = 1
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
