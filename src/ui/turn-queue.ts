// Полоса очереди ходов над картой: точки цвета игроков — кто ходит сейчас (первая,
// с акцентом) и кто идёт следом. С разными схемами очерёдности (по кругу / змейкой /
// постоянная) уследить за порядком на глаз трудно, поэтому очередь показываем явно.
// Порядок считает upcomingTurns() в turns.ts (учёт штрафных пропусков и доигровки).

import { GameState } from '../model/game';
import { upcomingTurns } from '../model/turns';

/** Сколько ходов вперёд показывать, считая текущий. */
const QUEUE_LEN = 9;

const el = document.getElementById('turnQueue') as HTMLElement;

/**
 * Обновить полосу: показываем только в идущей гонке. Первая точка — текущий игрок
 * (акцент рамкой), дальше очередь бледнеет с расстоянием, чтобы ближний ход читался
 * сильнее дальнего. Один и тот же игрок может встретиться несколько раз — это
 * нормально (он ходит на каждом круге).
 */
export function renderTurnQueue(game: GameState | null): void {
  if (!game || game.phase !== 'race') {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  const queue = upcomingTurns(game, QUEUE_LEN);
  const dots = queue.map((seat, i) => {
    const dot = document.createElement('span');
    dot.className =
      i === 0 ? 'turn-queue__dot turn-queue__dot--current' : 'turn-queue__dot';
    dot.style.background = game.players[seat].color;
    // Ближний ход — ярче дальнего: плавное затухание от текущего к хвосту очереди.
    if (i > 0) dot.style.opacity = String(Math.max(0.35, 1 - i * 0.09));
    return dot;
  });
  el.replaceChildren(...dots);
  el.hidden = false;
}
