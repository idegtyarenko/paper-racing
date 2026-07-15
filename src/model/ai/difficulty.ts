// Ручки силы бота: сложности и их параметры поиска. Чистые данные без DOM.

export type Difficulty = 'easy' | 'medium' | 'hard';

/** Настройки планировщика A* (только hard). */
export interface PlanParams {
  /** Лимит раскрытий узлов A*: выше — дальновиднее и оптимальнее план. */
  budget: number;
  /** Опорная скорость: перевод «клеток до финиша» в «ходы» для эвристики. */
  vref: number;
  /** Вес эвристики (>1 — жаднее к финишу): меньше раскрытий, чуть менее оптимально. */
  weight: number;
}

/** Ручки силы бота — см. таблицу в DIFFICULTY. */
export interface DifficultyParams {
  /** Глубина поиска в ходах (easy/medium). */
  depth: number;
  /** Лимит рекурсии canStop (easy/medium); на срезе — оптимистичное «успею». */
  stopCap: number;
  /** Мягкий потолок скорости: превышение штрафуется, но не запрещено. */
  maxSpeed: number;
  /** Вероятность взять случайный из почти-лучших ходов (разнообразие без дёрганья). */
  epsilon: number;
  /** Планировщик A* вместо перебора глубины (задан только у hard). */
  plan?: PlanParams;
}

export const DIFFICULTY: Record<Difficulty, DifficultyParams> = {
  easy: { depth: 1, stopCap: 2, maxSpeed: 4, epsilon: 0.3 },
  medium: { depth: 2, stopCap: 6, maxSpeed: 6, epsilon: 0.1 },
  // hard планирует время (A*), а не путь: vref/weight откалиброваны так, что на
  // рисованных извилистых трассах круг проходится за ~оптимум ходов, укладываясь
  // в единицы-десятки мс на ход (маскируется паузой AI_MOVE_DELAY_MS=600).
  hard: {
    depth: 3,
    stopCap: 12,
    maxSpeed: Infinity,
    epsilon: 0,
    plan: { budget: 4000, vref: 2.5, weight: 1.2 },
  },
};
