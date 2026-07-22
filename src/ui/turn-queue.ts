// Turn-queue strip above the map: player-colored dots showing who's moving now
// (the first one, highlighted) and who's up next. Players take turns in a
// rotating order (the starting player shifts each lap), which is hard to track
// by eye, so we show the queue explicitly. The order comes from
// upcomingSlots() in turns.ts (accounting for skipped penalty turns and
// catch-up moves). We draw a separator between laps: with two players the
// starting-player shift can produce the same color on both sides of a lap
// boundary (…○│○…), so the separator makes clear this is the end of one lap
// and the start of the next, not "the same player moving twice in a row". All
// dots share the same opacity.

import { GameState } from '../model/game';
import { upcomingSlots } from '../model/turns';

/** How many upcoming turns to show, including the current one. */
const QUEUE_LEN = 9;

const el = document.getElementById('turnQueue') as HTMLElement;
const dotsEl = document.getElementById('turnQueueDots') as HTMLElement;

/**
 * Update the strip: shown only during an active race. The first dot is the
 * current player (highlighted with an outline). The same player can appear
 * more than once — that's expected, since they take a turn every lap.
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
    // Lap change — insert a separator before the dot (except for the very first one).
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
