import { describe, it, expect } from 'vitest';
import { isPodium, msToClock } from './format';

describe('msToClock', () => {
  it('formats as m:ss with a leading zero on seconds', () => {
    expect(msToClock(42_000)).toBe('0:42');
    expect(msToClock(9_000)).toBe('0:09');
    expect(msToClock(125_000)).toBe('2:05');
    expect(msToClock(0)).toBe('0:00');
  });

  it('clamps negative time to 0:00', () => {
    expect(msToClock(-1)).toBe('0:00');
    expect(msToClock(-5_000)).toBe('0:00');
  });

  it('rounds up to the nearest second (0:01 still shows through the last second)', () => {
    expect(msToClock(41_500)).toBe('0:42');
    expect(msToClock(1)).toBe('0:01');
  });
});

describe('isPodium', () => {
  it('never counts the win itself — first place has its own message', () => {
    expect(isPodium(1, 2)).toBe(false);
    expect(isPodium(1, 6)).toBe(false);
  });

  it('losing a duel is just losing', () => {
    expect(isPodium(2, 2)).toBe(false);
  });

  it('second of three is still a loser, second of four is a result', () => {
    expect(isPodium(2, 3)).toBe(false);
    expect(isPodium(2, 4)).toBe(true);
  });

  it('takes the upper half of the field, so third needs six cars', () => {
    expect(isPodium(3, 4)).toBe(false);
    expect(isPodium(3, 5)).toBe(false);
    expect(isPodium(3, 6)).toBe(true);
    expect(isPodium(4, 6)).toBe(false);
  });
});
