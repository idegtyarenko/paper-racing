// Мелкие форматтеры для UI. Чистые функции — покрыты vitest.

/** Миллисекунды → «м:сс» (секунды с ведущим нулём). Отрицательное — «0:00». */
export function msToClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
