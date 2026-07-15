// Оценка и выбор хода: константы эвристик, ранжирование корней и epsilon-выбор.
// Общая для обеих стратегий (A* и перебор глубины) часть. Чистая логика без DOM.

import { Candidate } from '../game';
import { DifficultyParams } from './difficulty';

// ── Константы оценки (алгоритмические, не игровые — потому здесь, не в config) ──
/** Средняя крейсерская скорость: перевод потерянных ходов в «клетки пути». */
export const AVG_SPEED = 4;
/** Сколько ходов стоит разгон с нуля после возврата из гравия. */
export const RESTART_TURNS = 3;
/** Штраф листа, из которого нельзя гарантированно затормозить (≈ будущая авария). */
export const UNSAFE_PENALTY = 30;
/** Штраф за клетку превышения мягкого потолка скорости. */
export const OVERSPEED_PENALTY = 8;
/** Финишный ход вне конкуренции: бонус много больше любых расстояний. */
export const FINISH_BONUS = 1e6;
/** Цена хода задержки финиша: финишировать раньше важнее любой глубины заезда
 *  (глубина — лишь тай-брейк решающего круга при равном числе ходов). */
export const FINISH_DELAY_COST = 1e3;
/** Ходы в этой полосе от лучшего считаются «почти лучшими» (для epsilon-выбора). */
export const EPS_MARGIN = 3;

/** Результат ранжирования корней стратегией выбора хода. */
export interface Ranking {
  /** Оптимальный ход стратегии — возвращается всегда, кроме epsilon-разнообразия. */
  best: Candidate;
  /** Финиш/безвыходная авария — вернуть best точно (без epsilon-подмены). */
  terminal: boolean;
  /** Все корни со «стоимостью» (меньше — лучше): для epsilon-выбора easy/medium. */
  scored: { c: Candidate; score: number }[];
}

/**
 * Выбор хода из ранжированных корней: лучший (оптимум стратегии), кроме easy/medium,
 * где с вероятностью epsilon берётся случайный из почти-оптимальных — «живость» без
 * дёрганья. Расталкивания нет намеренно: у быстрого A* соперника обводят сам поиск
 * (blocked-ходы отсеяны в candidates, план строится в объезд), а искусственный штраф
 * за близость заставлял бота уступать гоночную линию любому сопернику и терять ~40%
 * темпа. Болиды и так расходятся: стартуют с разных клеток, A* из разных состояний
 * даёт разные линии, а blocked разводит на пересечениях.
 */
export function pickMove(
  rank: Ranking,
  P: DifficultyParams,
  rng: () => number,
): Candidate {
  const { best, terminal, scored } = rank;
  if (terminal) return best;
  if (P.epsilon > 0 && scored.length > 1) {
    let poolBest = scored[0].score;
    for (const s of scored) if (s.score < poolBest) poolBest = s.score;
    const near = scored.filter((s) => s.score <= poolBest + EPS_MARGIN);
    if (near.length > 1 && rng() < P.epsilon) {
      return near[Math.min(near.length - 1, Math.floor(rng() * near.length))].c;
    }
  }
  return best;
}
