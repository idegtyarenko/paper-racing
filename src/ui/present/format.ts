// Small UI formatters. Pure functions — covered by vitest.

/** Milliseconds → "m:ss" (seconds zero-padded). Negative values clamp to "0:00". */
export function msToClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Is this place worth congratulating, given how many cars started?
 *
 * A podium is relative to the field: second of four is a result, second of a
 * duel is just losing. The line is the upper half — `place * 2 <= total` —
 * which keeps 2nd-of-3 out (a three-car race has one winner and two losers)
 * and lets 3rd-of-6 in. First place is not a podium here: winning has its own
 * headline and subtitle, and this is what everyone *else* gets instead of
 * "better luck next time". `total` counts every car that started, retirements
 * included — dropping out doesn't make the survivors' places worth less.
 */
export function isPodium(place: number, total: number): boolean {
  return place > 1 && place * 2 <= total;
}
