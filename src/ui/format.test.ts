import { describe, it, expect } from 'vitest';
import { msToClock } from './format';

describe('msToClock', () => {
  it('форматирует как м:сс с ведущим нулём у секунд', () => {
    expect(msToClock(42_000)).toBe('0:42');
    expect(msToClock(9_000)).toBe('0:09');
    expect(msToClock(125_000)).toBe('2:05');
    expect(msToClock(0)).toBe('0:00');
  });

  it('отрицательное время клампится в 0:00', () => {
    expect(msToClock(-1)).toBe('0:00');
    expect(msToClock(-5_000)).toBe('0:00');
  });

  it('округляет вверх до секунды (в последнюю секунду ещё видно 0:01)', () => {
    expect(msToClock(41_500)).toBe('0:42');
    expect(msToClock(1)).toBe('0:01');
  });
});
