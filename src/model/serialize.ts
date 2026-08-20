// JSON form of the model: how a Track and a race state are flattened for storage and
// rebuilt afterwards. This is the model's own format, not any one transport's — both
// the online row (`online/net.ts`) and the local snapshot (`persist.ts`) are clients of
// it, which is why it lives here rather than in the network layer.
//
// No clocks and no transport here: a stored snapshot says what the race *is*, not when
// or where it was written. A layer that needs more than that (the wire stamps the
// writer's clock onto the row) declares the extra field on its own side; deserialize
// below builds the state field by field, so nothing a caller added can leak in.
//
// Reading is where compatibility lives: a row or a snapshot may have been written by an
// older client, so deserialize backfills fields that didn't exist then. The shape guards
// below check only the skeleton — enough to normalize safely, not a full schema.

import { Vec } from '../geometry';
import { Track } from './track';
import { GameState, normalizeRules } from './game';

/** Track in JSON form: the `inside` Set is expanded into an array. */
export interface SerializedTrack {
  outer: Vec[];
  inner: Vec[];
  finish: { a: Vec; b: Vec };
  forward: Vec;
  inside: number[];
  startPoints: Vec[];
}

/** Race state without the `track` field — the track is immutable and stored separately. */
export type SerializedState = Omit<GameState, 'track'>;

export function serializeTrack(t: Track): SerializedTrack {
  return {
    outer: t.outer,
    inner: t.inner,
    finish: t.finish,
    forward: t.forward,
    inside: [...t.inside],
    startPoints: t.startPoints,
  };
}

/**
 * Reconstructs the track. Framing is derived from the track's bbox (fit-to-track),
 * so it's the same on every device. Old JSON rows may still carry dead
 * `worldW`/`worldH` fields (once the host's world dimensions) — we simply ignore them.
 */
export function deserializeTrack(s: SerializedTrack): Track {
  return {
    outer: s.outer,
    inner: s.inner,
    finish: s.finish,
    forward: s.forward,
    inside: new Set(s.inside),
    startPoints: s.startPoints,
  };
}

export function serializeState(g: GameState): SerializedState {
  const { track: _track, ...rest } = g;
  return rest;
}

/**
 * Rebuild a race state around the given track.
 *
 * Every field is listed out — players included — rather than spread from the input,
 * which is what keeps a caller's own additions (the wire's clock stamp, say) from
 * riding into the model through a field nobody here declared.
 *
 * Two consequences, both deliberate. A new `GameState` or `Player` field has to be
 * added below as well: the compiler then stops on exactly the question this function
 * exists to answer — what an older snapshot, written before that field existed, should
 * get instead. And a field this build of the code doesn't know about is dropped rather
 * than carried through. That matters only in online play, where everyone rewrites the
 * whole row: mid-rollout, a client on the older build erases a field the newer one
 * added, instead of passing it along untouched. Preserving it wouldn't have been safe
 * either — the old build never updates such a field, so it would hand back a stale
 * value as if it were current — and a row that outlives its schema needs a version to
 * sort out, not a spread.
 */
export function deserializeState(s: SerializedState, track: Track): GameState {
  return {
    track,
    current: s.current,
    phase: s.phase,
    winner: s.winner,
    finalTurnsLeft: s.finalTurnsLeft,
    roundFinishers: s.roundFinishers,
    // Normalize rules: backfill defaults (so new fields aren't undefined on old
    // rows) plus migrate legacy physics → drive.
    rules: normalizeRules(s.rules),
    // The turn counter travels inside the state; old rows without it get turn 0 —
    // a safe starting point for the rotation.
    turn: s.turn ?? 0,
    // Start-grid turn order: old snapshots without this field get the identity
    // permutation (previous behavior — turn order by seat index).
    startGridOrder:
      s.startGridOrder ?? Array.from({ length: s.players.length }, (_, i) => i),
    players: s.players.map((p) => ({
      name: p.name,
      color: p.color,
      pos: p.pos,
      vel: p.vel,
      trail: p.trail,
      crashes: p.crashes,
      skipTurns: p.skipTurns,
      crossings: p.crossings,
      finishOvershoot: p.finishOvershoot,
      place: p.place,
      retired: p.retired,
      bot: p.bot,
      // Gravel turns served and turns given up standing still: absent on rows written
      // before those counters existed — such races just under-report a crash or a
      // passed turn, which is exactly the old behavior, so zero is the right backfill.
      penaltyTurns: p.penaltyTurns ?? 0,
      stationaryTurns: p.stationaryTurns ?? 0,
      // When the car cut the finish line: absent on rows written before places
      // were decided by it. Null there means the round falls back to overshoot
      // depth — the old behavior, and the only one such a row has data for.
      finishCrossAt: p.finishCrossAt ?? null,
    })),
  };
}

// ── Validating incoming data ────────────────────────────────────────────────────
//
// Data read back from storage (a realtime row, an RPC/query response, a localStorage
// string) arrives as `unknown`. It used to be cast with `as` — a promise, not a check.
// Here we do a lightweight SHAPE check (not a full schema): make sure the skeleton is
// present and of the right type, so we can safely normalize afterward
// (deserializeState) instead of running into a broken state after future format
// changes. We don't migrate values here — only shape.

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isVec(v: unknown): v is Vec {
  return isObj(v) && typeof v.x === 'number' && typeof v.y === 'number';
}

function isVecArray(v: unknown): v is Vec[] {
  return Array.isArray(v) && v.every(isVec);
}

/** Shape of a serialized track: base fields are present and of the right type. */
export function isSerializedTrack(v: unknown): v is SerializedTrack {
  if (!isObj(v)) return false;
  const f = v.finish;
  return (
    isVecArray(v.outer) &&
    isVecArray(v.inner) &&
    isObj(f) &&
    isVec(f.a) &&
    isVec(f.b) &&
    isVec(v.forward) &&
    Array.isArray(v.inside) &&
    isVecArray(v.startPoints)
  );
}

/** Shape of a serialized race state (without track — that's stored separately). Not
 *  full validation — just the skeleton needed to safely normalize afterward. */
export function isSerializedState(v: unknown): v is SerializedState {
  return isObj(v) && Array.isArray(v.players) && typeof v.current === 'number';
}
