import { describe, it, expect } from 'vitest';
import { Rules, DEFAULT_RULES, crashPenalty, newGame, cloneState } from './game';
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

describe('cloneState', () => {
  it('глубоко независим по игрокам, но track — по ссылке', () => {
    const g = newGame(ringTrack(), 2);
    const c = cloneState(g);
    c.players[0].pos.x = 999;
    expect(g.players[0].pos.x).not.toBe(999);
    expect(c.track).toBe(g.track);
  });
});
