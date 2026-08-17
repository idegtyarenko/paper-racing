import { describe, it, expect } from 'vitest';
import { newGame } from './game';
import { buildNavField } from './nav';
import { computeStandings, turnsTaken } from './standings';
import { applyMove, coastMove } from './turns';
import { chooseMove } from './ai';
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

describe('turnsTaken', () => {
  /** A normal (driven) trail segment between two arbitrary points. */
  const seg = (n: number) => ({
    from: { x: n, y: 0 },
    to: { x: n + 1, y: 0 },
    jump: false,
    turn: n,
  });

  it('counts one per driven segment', () => {
    const { g } = setup();
    g.players[0].trail = [seg(0), seg(1), seg(2)];
    expect(turnsTaken(g.players[0])).toBe(3);
  });

  it('is zero before the first move', () => {
    const { g } = setup();
    expect(turnsTaken(g.players[0])).toBe(0);
  });

  it("doesn't count the teleport back onto the track after a crash", () => {
    const { g } = setup();
    // returnFromPenalty pushes a `jump` segment: the car is moved, but the
    // player never spent a move on it.
    g.players[0].trail = [seg(0), seg(1), { ...seg(2), jump: true }, seg(3)];
    expect(turnsTaken(g.players[0])).toBe(3);
  });

  it('counts turns already served in the gravel — a crash is not free', () => {
    const { g } = setup();
    // A pit turn pushes no segment at all, so without penaltyTurns a crash
    // would cost nothing in the final classification.
    const p = g.players[0];
    p.trail = [seg(0), seg(1)];
    p.penaltyTurns = 3;
    expect(turnsTaken(p)).toBe(5);
  });

  it('counts a turn passed standing still — it burned a slot like any other', () => {
    const { g } = setup();
    // A pass (nowhere for inertia to carry the car, or the inertial cell taken)
    // pushes no segment either: without stationaryTurns the car would look
    // faster than the one that actually drove those turns.
    const p = g.players[0];
    p.trail = [seg(0), seg(1)];
    p.stationaryTurns = 2;
    expect(turnsTaken(p)).toBe(4);
  });

  it("doesn't count a penalty that hasn't been served yet", () => {
    const { g } = setup();
    // skipTurns is what's still owed; only turns actually burned add up.
    const p = g.players[0];
    p.trail = [seg(0), seg(1)];
    p.skipTurns = 2;
    expect(turnsTaken(p)).toBe(2);
  });

  // The number on the final screen has to agree with the order of the rows it
  // sits in: whoever finished earlier cannot have spent more turns doing it.
  // Every car is offered exactly one slot per lap, so this only holds while
  // every burned slot is counted — the invariant that a silently passed turn
  // used to break.
  it('never contradicts the finishing order in a full race', () => {
    const track = ringTrack();
    const nav = buildNavField(track);
    for (let run = 0; run < 5; run++) {
      let seed = 1000 + run * 7919;
      const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      const g = newGame(track, 3);
      let guard = 0;
      while (g.phase === 'race' && guard++ < 500) {
        const cand = chooseMove(g, nav, 'easy', rng);
        if (cand) applyMove(g, cand);
        else coastMove(g);
      }
      expect(g.phase).toBe('over');
      const byPlace = [...g.players].sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
      byPlace.forEach((p, i) => {
        for (const later of byPlace.slice(i + 1)) {
          if (later.place !== p.place)
            expect(turnsTaken(later)).toBeGreaterThanOrEqual(turnsTaken(p));
        }
      });
    }
  });
});
