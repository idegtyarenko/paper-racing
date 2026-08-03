import { describe, it, expect } from 'vitest';
import { botMoveDelayMs } from './bot-pacing';
import { AI_MOVE_DELAY_MS, AI_MOVE_DELAY_MIN_MS } from './config';

describe('botMoveDelayMs', () => {
  it('gives the first bot of a run the full pause', () => {
    expect(botMoveDelayMs(0)).toBe(AI_MOVE_DELAY_MS);
  });

  it('shrinks with every next bot in the run', () => {
    const delays = [0, 1, 2, 3].map(botMoveDelayMs);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeLessThan(delays[i - 1]);
  });

  it('never goes below the floor, however long the run', () => {
    for (const i of [4, 10, 100]) expect(botMoveDelayMs(i)).toBe(AI_MOVE_DELAY_MIN_MS);
  });

  it('costs a five-bot run barely more than half of five full pauses', () => {
    const total = [0, 1, 2, 3, 4].reduce((sum, i) => sum + botMoveDelayMs(i), 0);
    expect(total).toBeLessThan(AI_MOVE_DELAY_MS * 5 * 0.55);
  });
});
