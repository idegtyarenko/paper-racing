import { describe, it, expect } from 'vitest';
import { msToClock } from './format';

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
