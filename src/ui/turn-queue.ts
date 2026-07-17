// Полоса очереди ходов над картой: точки цвета игроков — кто ходит сейчас (первая,
// с акцентом) и кто идёт следом. Игроки ходят по кругу (стартовый сдвигается каждый
// круг), и уследить за порядком на глаз трудно, поэтому очередь показываем явно.
// Порядок считает upcomingSlots() в turns.ts (учёт штрафных пропусков и доигровки).
// Между кругами рисуем разделитель: у двух игроков стартовый сдвиг даёт одинаковый
// цвет на стыке (…○│○…) — разделитель показывает, что это конец одного круга и
// начало следующего, а не «ход дважды подряд». Все точки — одной непрозрачности.

import { GameState } from '../model/game';
import { upcomingSlots } from '../model/turns';

/** Сколько ходов вперёд показывать, считая текущий. */
const QUEUE_LEN = 9;

const el = document.getElementById('turnQueue') as HTMLElement;
const dotsEl = document.getElementById('turnQueueDots') as HTMLElement;

/**
 * Обновить полосу: показываем только в идущей гонке. Первая точка — текущий игрок
 * (акцент рамкой). Один и тот же игрок может встретиться несколько раз — это
 * нормально (он ходит на каждом круге).
 */
export function renderTurnQueue(game: GameState | null): void {
  if (!game || game.phase !== 'race') {
    el.hidden = true;
    dotsEl.replaceChildren();
    return;
  }
  const slots = upcomingSlots(game, QUEUE_LEN);
  const children: HTMLElement[] = [];
  let prevRound: number | null = null;
  slots.forEach((slot, i) => {
    // Смена круга — вставляем разделитель перед точкой (кроме самой первой).
    if (prevRound !== null && slot.round !== prevRound) {
      const sep = document.createElement('span');
      sep.className = 'turn-queue__sep';
      children.push(sep);
    }
    prevRound = slot.round;
    const dot = document.createElement('span');
    dot.className =
      i === 0 ? 'turn-queue__dot turn-queue__dot--current' : 'turn-queue__dot';
    dot.style.background = game.players[slot.seat].color;
    children.push(dot);
  });
  dotsEl.replaceChildren(...children);
  el.hidden = false;
}
