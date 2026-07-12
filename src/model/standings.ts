// Живой расчёт положения болидов (кто на каком месте прямо сейчас) для полосы
// мест в стиле Ф1. Чистая логика без DOM; переиспользует навигационное поле
// ботов (buildNavField/navAt) как оценку «сколько ещё ехать до финиша».

import { GameState, WIN_CROSSINGS } from './game';
import { NavField, navAt } from './nav';

/**
 * Оставшаяся дистанция болида до победы в «шагах» поля: недоеханные круги плюс
 * расстояние до ближайшего финиша. Чем меньше — тем ближе к победе. Болид,
 * уже пересёкший финиш в текущем (ещё не разрешённом) раунде, получает
 * отрицательное слагаемое за «лишний» круг и корректно оказывается впереди всех
 * ещё едущих.
 */
function remaining(state: GameState, nav: NavField, seat: number): number {
  const p = state.players[seat];
  return (WIN_CROSSINGS - 1 - p.crossings) * nav.lap + navAt(nav, p.pos);
}

/**
 * Порядок болидов от 1-го места к последнему для полосы положений:
 *  1) уже получившие место (финишировали в разрешённом раунде) — по place;
 *  2) ещё едущие — по оставшейся дистанции до финиша (ближе → выше);
 *  3) сдавшиеся — в конце, в порядке мест (seat).
 * Возвращает индексы игроков (seat'ы).
 */
export function computeStandings(state: GameState, nav: NavField): number[] {
  const seats = state.players.map((_, i) => i);
  const rank = (i: number): [number, number] => {
    const p = state.players[i];
    if (p.place !== null) return [0, p.place];
    if (p.retired) return [2, i];
    return [1, remaining(state, nav, i)];
  };
  return seats.sort((a, b) => {
    const [ga, va] = rank(a);
    const [gb, vb] = rank(b);
    return ga !== gb ? ga - gb : va - vb;
  });
}
