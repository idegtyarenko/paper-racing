import { describe, it, expect } from 'vitest';
import { newGame } from './game';
import { buildNavField } from './nav';
import { computeStandings } from './standings';
import { WIN_CROSSINGS } from '../config';
import { ringTrack } from './test-fixtures';

/** Shared fixture: 4 cars on a ring + the track's navigation field. */
function setup() {
  const track = ringTrack();
  return { g: newGame(track, 4), nav: buildNavField(track) };
}

describe('computeStandings', () => {
  it('finishers are ordered by place, ahead of those still racing and those retired', () => {
    const { g, nav } = setup();
    g.players[0].place = 2;
    g.players[1].place = 1;
    g.players[2].retired = true;
    // p3 is still racing (place null, not retired)
    expect(computeStandings(g, nav)).toEqual([1, 0, 3, 2]);
  });

  it('among those still racing, the one with fewer laps left ranks higher', () => {
    const { g, nav } = setup();
    // p2 has completed one more lap — closer to winning, so ranks higher.
    g.players[2].crossings = WIN_CROSSINGS - 1;
    // The others are at the start (crossings 0). Put them all at the same spot so the
    // difference comes only from the lap counter, not track position.
    const spot = { ...g.players[2].pos };
    [0, 1, 3].forEach((i) => (g.players[i].pos = { ...spot }));
    expect(computeStandings(g, nav)[0]).toBe(2);
  });

  it('retired players are placed last, in seat order', () => {
    const { g, nav } = setup();
    g.players[0].retired = true;
    g.players[2].retired = true;
    const order = computeStandings(g, nav);
    expect(order.slice(-2)).toEqual([0, 2]);
  });

  it('a car that crossed the finish in an unresolved round ranks ahead of those still racing', () => {
    const { g, nav } = setup();
    // p1 has already crossed the finish the required number of times (place not yet assigned — round is still open).
    g.players[1].crossings = WIN_CROSSINGS;
    expect(computeStandings(g, nav)[0]).toBe(1);
  });
});
