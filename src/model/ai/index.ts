// ИИ-соперник: навигация по трассе и выбор хода. Чистая логика без DOM.
//
// Навигация — поле расстояний до финиша (BFS по узлам дороги track.inside,
// 8-связность): dist(клетка) = шагов при скорости 1 до следующего пересечения
// финишной линии вперёд (см. nav.ts).
//
// Выбор хода зависит от сложности:
// Все уровни — один планировщик A* по состояниям (pos, vel), минимизирующий ЧИСЛО
// ХОДОВ до следующего пересечения финиша вперёд (см. planner.ts). Так рождаются
// гоночная траектория и торможение перед поворотом. Уровни различаются «ослаблением»:
// горизонт планирования, жадность эвристики, потолок скорости, шум выбора и инвариант
// торможения (easy идёт по краю и иногда бьётся) — см. таблицу DIFFICULTY.
//
// Соперники учитываются только на первом слое (blocked-ходы отсеяны в candidates():
// нельзя встать на чужую клетку или проехать сквозь неё) — к более глубоким слоям
// они всё равно сдвинутся, а A* при занятой оптимальной клетке строит план в объезд.
// Искусственного «расталкивания» пачки нет намеренно: штраф за близость к сопернику
// заставлял бота уступать гоночную линию и терял ~40% темпа; болиды и без него
// расходятся (разные старты → разные A*-линии, blocked разводит на пересечениях).

import { GameState, Candidate } from '../game';
import { NavField } from '../nav';
import { candidates } from '../turns';
import { Difficulty, DIFFICULTY } from './difficulty';
import { scoreByPlan } from './planner';
import { pickMove } from './scoring';

export type { Difficulty };

/**
 * Выбрать ход бота из candidates(state). Возвращает не-blocked кандидата;
 * null — пат (все 9 заняты соперниками), вызывающий пасует (coastMove).
 * Соперники дальше первого слоя не учитываются — к тому времени они сдвинутся.
 */
export function chooseMove(
  state: GameState,
  nav: NavField,
  difficulty: Difficulty,
  rng: () => number = Math.random,
): Candidate | null {
  const P = DIFFICULTY[difficulty];
  const open = candidates(state).filter((c) => !c.blocked);
  if (open.length === 0) return null;

  // Ранжирование корней: best — оптимальный ход стратегии, scored — почти-оптимальные
  // (для epsilon-разнообразия easy/medium), terminal — финиш/безвыходная авария.
  const rank = scoreByPlan(
    state,
    nav,
    open,
    P.plan,
    P.maxSpeed,
    P.stopCap,
    P.enforceStop,
  );

  return pickMove(rank, P, rng);
}
