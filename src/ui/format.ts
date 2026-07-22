// Small UI formatters. Pure functions — covered by vitest.

/** Milliseconds → "m:ss" (seconds zero-padded). Negative values clamp to "0:00". */
export function msToClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
