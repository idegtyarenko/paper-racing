import { describe, it, expect } from 'vitest';
import { newGame, GameState, TrailSeg } from '../model/game';
import { ringTrack } from '../model/test-fixtures';
import { buildTimeline, sampleTimeline } from './replay-timeline';

/**
 * A finished-looking game with hand-written trails: the timeline only ever
 * reads trails, so a fixture that states the turn stamps outright is clearer
 * (and far shorter) than driving a race to produce them.
 */
function gameWithTrails(trails: TrailSeg[][]): GameState {
  const g = newGame(ringTrack(), trails.length);
  trails.forEach((t, i) => {
    g.players[i].trail = t;
    if (t.length) g.players[i].pos = { ...t[t.length - 1].to };
  });
  g.phase = 'over';
  return g;
}

const seg = (turn: number, x0: number, x1: number, jump = false): TrailSeg => ({
  from: { x: x0, y: 4 },
  to: { x: x1, y: 4 },
  jump,
  turn,
});

describe('buildTimeline', () => {
  it('puts the moves of one round on the same beat', () => {
    // Two players: turns 0 and 1 are the first round, 2 and 3 the second.
    const g = gameWithTrails([
      [seg(0, 10, 12), seg(2, 12, 15)],
      [seg(1, 10, 11), seg(3, 11, 13)],
    ]);
    const tl = buildTimeline(g);
    expect(tl.rounds).toBe(2);
    expect(tl.bySeat[0].map((h) => h.round)).toEqual([0, 1]);
    expect(tl.bySeat[1].map((h) => h.round)).toEqual([0, 1]);
  });

  it('falls back to segment order when the stamps are missing', () => {
    // Snapshots written before segments carried a turn: better a replay that
    // runs a little off than a button that does nothing.
    const g = gameWithTrails([[seg(0, 10, 12), seg(0, 12, 15)], [seg(0, 10, 11)]]);
    const legacy = g.players[0].trail.map(
      (s) => ({ from: s.from, to: s.to, jump: s.jump }) as TrailSeg,
    );
    g.players[0].trail = legacy;
    const tl = buildTimeline(g);
    expect(tl.bySeat[0].map((h) => h.round)).toEqual([0, 1]);
    expect(tl.rounds).toBe(2);
  });

  it('has no hops for a race nobody drove', () => {
    const tl = buildTimeline(gameWithTrails([[], []]));
    expect(tl.hops).toHaveLength(0);
    expect(tl.rounds).toBe(0);
  });
});

describe('sampleTimeline', () => {
  const g = gameWithTrails([[seg(0, 10, 12), seg(2, 12, 16)], [seg(1, 10, 11)]]);
  const tl = buildTimeline(g);

  it('starts every car on the grid', () => {
    const f = sampleTimeline(tl, g, 0);
    expect(f.pos[0]).toEqual({ x: 10, y: 4 });
    expect(f.pos[1]).toEqual({ x: 10, y: 4 });
    expect(f.segsShown[0]).toBe(0);
  });

  it('interpolates within a round', () => {
    const f = sampleTimeline(tl, g, 0.5);
    expect(f.pos[0]).toEqual({ x: 11, y: 4 }); // halfway along 10 -> 12
    expect(f.partialTo[0]).toEqual({ x: 11, y: 4 });
    expect(f.segsShown[0]).toBe(0); // no whole segment driven yet
  });

  it('counts a segment as driven once its round is over', () => {
    const f = sampleTimeline(tl, g, 1);
    expect(f.pos[0]).toEqual({ x: 12, y: 4 });
    expect(f.segsShown[0]).toBe(1);
  });

  it('leaves a car that has no move this round standing where it stopped', () => {
    // Seat 1 only ever drove in round 0 — in round 1 it just sits there.
    const f = sampleTimeline(tl, g, 1.5);
    expect(f.pos[1]).toEqual({ x: 11, y: 4 });
    expect(f.segsShown[1]).toBe(1);
    expect(f.partialTo[1]).toBeNull();
  });

  it('ends with every car on its final point', () => {
    const f = sampleTimeline(tl, g, tl.rounds);
    expect(f.pos[0]).toEqual({ x: 16, y: 4 });
    expect(f.pos[1]).toEqual({ x: 11, y: 4 });
    expect(f.segsShown[0]).toBe(2);
  });

  it('makes the jump out of the gravel instant', () => {
    // Seat 0 crashes in round 0, sits out rounds 1-2, is put back on the track
    // by the teleport stamped in round 3.
    const gj = gameWithTrails([[seg(0, 10, 12), seg(6, 12, 14, true)], [seg(1, 10, 11)]]);
    const tj = buildTimeline(gj);
    expect(sampleTimeline(tj, gj, 2.5).pos[0]).toEqual({ x: 12, y: 4 }); // still stuck
    // The whole of round 3 is spent at the far end — a teleport has no middle.
    expect(sampleTimeline(tj, gj, 3.01).pos[0]).toEqual({ x: 14, y: 4 });
    expect(sampleTimeline(tj, gj, 3.5).pos[0]).toEqual({ x: 14, y: 4 });
  });

  it('shows a crash mark only once the car has crashed', () => {
    const gc = gameWithTrails([[seg(0, 10, 12), seg(2, 12, 15)], []]);
    gc.players[0].crashes = [{ x: 15, y: 4 }];
    const tc = buildTimeline(gc);
    expect(sampleTimeline(tc, gc, 1.5).crashesShown[0]).toBe(0);
    expect(sampleTimeline(tc, gc, 2).crashesShown[0]).toBe(1);
  });
});
