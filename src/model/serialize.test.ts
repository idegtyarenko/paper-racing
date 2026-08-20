import { describe, it, expect } from 'vitest';
import { ringTrack, gameOn } from './test-fixtures';
import {
  serializeTrack,
  deserializeTrack,
  serializeState,
  deserializeState,
  isSerializedTrack,
  isSerializedState,
  SerializedState,
} from './serialize';

describe('serializeTrack / deserializeTrack', () => {
  it('survives a round trip, restoring `inside` as a Set', () => {
    const track = ringTrack();
    const back = deserializeTrack(serializeTrack(track));

    expect(back.inside).toBeInstanceOf(Set);
    expect([...back.inside].sort()).toEqual([...track.inside].sort());
    expect(back.outer).toEqual(track.outer);
    expect(back.inner).toEqual(track.inner);
    expect(back.finish).toEqual(track.finish);
    expect(back.forward).toEqual(track.forward);
    expect(back.startPoints).toEqual(track.startPoints);
  });

  it('survives JSON, which is what storage actually does to it', () => {
    const track = ringTrack();
    const wire = JSON.parse(JSON.stringify(serializeTrack(track)));
    expect([...deserializeTrack(wire).inside].sort()).toEqual([...track.inside].sort());
  });
});

describe('serializeState / deserializeState', () => {
  it('drops the track on the way out and puts the given one back on the way in', () => {
    const track = ringTrack();
    const g = gameOn(track, 2);
    const s = serializeState(g);

    expect('track' in s).toBe(false);
    expect(deserializeState(s, track)).toEqual(g);
  });

  it('keeps the model free of clocks — nothing is stamped on serialize', () => {
    const s = serializeState(gameOn(ringTrack(), 2)) as Record<string, unknown>;
    expect('turnStartedAt' in s).toBe(false);
  });

  it('ignores fields a caller added of its own — they never reach the state', () => {
    const track = ringTrack();
    // The online row carries the writer's clock next to the snapshot; the local
    // snapshot used to carry the same stamp. Neither belongs to the model.
    const base = serializeState(gameOn(track, 2));
    const withExtras = {
      ...base,
      turnStartedAt: Date.now(),
      somethingFuture: 'whatever',
      players: base.players.map((p) => ({ ...p, perPlayerExtra: 'junk' })),
    };

    const back = deserializeState(withExtras, track) as unknown as Record<
      string,
      unknown
    >;
    expect('turnStartedAt' in back).toBe(false);
    expect('somethingFuture' in back).toBe(false);
    // Players are enumerated too — the guarantee holds one level down, not just at the top.
    for (const p of back.players as Record<string, unknown>[]) {
      expect('perPlayerExtra' in p).toBe(false);
    }
  });

  it('carries player state through a JSON round trip', () => {
    const track = ringTrack();
    const g = gameOn(track, 3);
    g.players[1].penaltyTurns = 2;
    g.players[2].finishCrossAt = 7;
    g.turn = 5;

    const back = deserializeState(
      JSON.parse(JSON.stringify(serializeState(g))) as SerializedState,
      track,
    );
    expect(back.players[1].penaltyTurns).toBe(2);
    expect(back.players[2].finishCrossAt).toBe(7);
    expect(back.turn).toBe(5);
  });
});

describe('deserializeState backfills snapshots from older clients', () => {
  const track = ringTrack();

  /** Erase a field the way an older client's JSON simply wouldn't have it. */
  function drop(o: object, key: string): void {
    delete (o as Record<string, unknown>)[key];
  }

  /** A snapshot as an older client wrote it: the fields added later are simply absent. */
  function legacySnapshot(): SerializedState {
    const s = serializeState(gameOn(track, 2));
    drop(s, 'turn');
    drop(s, 'startGridOrder');
    for (const p of s.players) {
      drop(p, 'penaltyTurns');
      drop(p, 'stationaryTurns');
      drop(p, 'finishCrossAt');
    }
    return s;
  }

  it('starts the turn counter at 0', () => {
    expect(deserializeState(legacySnapshot(), track).turn).toBe(0);
  });

  it('falls back to turn order by seat index', () => {
    expect(deserializeState(legacySnapshot(), track).startGridOrder).toEqual([0, 1]);
  });

  it('zeroes the counters that did not exist yet and nulls the finish crossing', () => {
    const back = deserializeState(legacySnapshot(), track);
    for (const p of back.players) {
      expect(p.penaltyTurns).toBe(0);
      expect(p.stationaryTurns).toBe(0);
      expect(p.finishCrossAt).toBeNull();
    }
  });

  it('normalizes rules, so a field added later is never undefined', () => {
    const s = legacySnapshot();
    s.rules = {} as typeof s.rules;
    const rules = deserializeState(s, track).rules;
    for (const [key, value] of Object.entries(rules)) {
      expect(value, `rules.${key} is undefined after normalize`).toBeDefined();
    }
  });
});

describe('shape guards', () => {
  it('accepts what serialize produced', () => {
    const track = ringTrack();
    expect(isSerializedTrack(serializeTrack(track))).toBe(true);
    expect(isSerializedState(serializeState(gameOn(track, 2)))).toBe(true);
  });

  it('rejects non-objects', () => {
    for (const junk of [null, undefined, 42, 'nope', []]) {
      expect(isSerializedTrack(junk)).toBe(false);
      expect(isSerializedState(junk)).toBe(false);
    }
  });

  it('rejects a state without the skeleton fields', () => {
    expect(isSerializedState({ current: 0 })).toBe(false);
    expect(isSerializedState({ players: [] })).toBe(false);
    expect(isSerializedState({ players: 'two', current: 0 })).toBe(false);
  });

  it('rejects a track whose points are not points', () => {
    const ok = serializeTrack(ringTrack());
    expect(isSerializedTrack({ ...ok, outer: [{ x: 1 }] })).toBe(false);
    expect(isSerializedTrack({ ...ok, finish: { a: { x: 0, y: 0 } } })).toBe(false);
    expect(isSerializedTrack({ ...ok, inside: 'nope' })).toBe(false);
  });
});
