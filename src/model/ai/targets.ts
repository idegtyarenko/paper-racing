// Раскрытие узлов поиска у бота: из состояния (pos, vel) — достижимые цели хода.
// Единственная точка, где бот раскрывает ходы; физика заезда «приходит» сюда
// параметром и разворачивается тем же генератором, что у движка (turns.ts).
// В следующем пункте арки меняется только тело reachableTargets — этот адаптер нет.

import { Vec } from '../../geometry';
import { Rules } from '../game';
import { reachableTargets } from '../turns';

/** Достижимые цели хода из (pos, vel) по физике заезда. */
export function expand(pos: Vec, vel: Vec, physics: Rules['physics']): Vec[] {
  return reachableTargets(pos, vel, physics);
}
