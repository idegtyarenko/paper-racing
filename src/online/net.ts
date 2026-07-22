// Network layer for online mode: the Supabase client, track/state serialization, and
// operations on the game row. No DOM here — just transport and (de)serialization.
//
// Model is "shared state, mover writes it": the active player applies their move
// locally and writes the game row; everyone else picks up the change via the realtime subscription.

import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { Vec } from '../geometry';
import { Track } from '../model/track';
import { GameState, normalizeRules } from '../model/game';
import { NET_TIMEOUT_MS } from '../config';

// ── Serialization ────────────────────────────────────────────────────────────────

/** Track in JSON form: the `inside` Set is expanded into an array. */
export interface SerializedTrack {
  outer: Vec[];
  inner: Vec[];
  finish: { a: Vec; b: Vec };
  forward: Vec;
  inside: number[];
  startPoints: Vec[];
}

/** Race state without the `track` field (the track is stored separately on the row and is immutable). */
export type SerializedState = Omit<GameState, 'track'>;

export interface RosterEntry {
  clientId: string;
  name: string;
}

export interface GameRow {
  id: string;
  track: SerializedTrack;
  state: SerializedState | null;
  lobby: RosterEntry[];
  host_id: string;
  status: 'lobby' | 'race' | 'over';
}

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

export function deserializeState(s: SerializedState, track: Track): GameState {
  // Rules and the turn counter travel inside the state; old rows without them
  // get a default (turn 0 — a safe starting point for the rotation).
  return {
    ...s,
    // Normalize rules: backfill defaults (so new fields aren't undefined on old
    // rows) plus migrate legacy physics → drive.
    rules: normalizeRules(s.rules),
    turn: s.turn ?? 0,
    // Start-grid turn order: old snapshots without this field get the identity
    // permutation (previous behavior — turn order by seat index).
    startGridOrder:
      s.startGridOrder ?? Array.from({ length: s.players.length }, (_, i) => i),
    track,
  };
}

// ── Validating incoming data ────────────────────────────────────────────────────
//
// Data from the network (a realtime row, an RPC/query response) arrives as
// `unknown`. It used to be cast with `as` — a promise, not a check. Here we do a
// lightweight SHAPE check (not a full schema): make sure the skeleton is present and
// of the right type, so we can safely normalize afterward (deserializeState) instead
// of running into a broken state after future format changes. We don't migrate
// values here — only shape.

function isObj(v: unknown): v is Record<string, unknown> {
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

/** Shape of a serialized race state (without track — that's stored separately on the
 *  row). Not full validation — just the skeleton needed to safely normalize afterward. */
export function isSerializedState(v: unknown): v is SerializedState {
  return isObj(v) && Array.isArray(v.players) && typeof v.current === 'number';
}

/**
 * Validate an incoming game row and return it, or null if the data is bad (wrong
 * shape — a truncated message, a foreign/old format). On null, the caller falls back
 * gracefully (keeps the last valid state / treats the game as not found) instead of
 * running with a broken state.
 */
export function parseGameRow(raw: unknown): GameRow | null {
  if (!isObj(raw)) return null;
  if (typeof raw.id !== 'string') return null;
  if (!isSerializedTrack(raw.track)) return null;
  if (raw.state !== null && !isSerializedState(raw.state)) return null;
  if (!Array.isArray(raw.lobby)) return null;
  if (typeof raw.host_id !== 'string') return null;
  if (raw.status !== 'lobby' && raw.status !== 'race' && raw.status !== 'over')
    return null;
  return raw as unknown as GameRow;
}

// ── Identity and game code ──────────────────────────────────────────────────────

const CLIENT_ID_KEY = 'pr-client-id';

/** Fallback id for the current session when localStorage is unavailable (private
 *  browsing): stable across calls, but doesn't survive a reload. */
let sessionClientId: string | null = null;

/** Stable id for this browser — survives a reload (needed to keep a lobby seat). */
export function clientId(): string {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    // localStorage unavailable (private browsing) — keep the id in memory for this session.
    if (!sessionClientId) sessionClientId = crypto.randomUUID();
    return sessionClientId;
  }
}

// Alphabet without lookalike characters (0/O, 1/I) — easier to read out loud and type.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode(len = 5): string {
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[a[i] % CODE_ALPHABET.length];
  return s;
}

// ── Supabase client ──────────────────────────────────────────────────────────────

let client: SupabaseClient | null = null;

/** Whether online mode is configured (Supabase env vars are set). */
export function onlineAvailable(): boolean {
  return !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
}

function db(): SupabaseClient {
  if (!client) {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error('supabase-not-configured');
    client = createClient(url, key, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 5 } },
    });
  }
  return client;
}

// ── Operations ─────────────────────────────────────────────────────────────────────

/**
 * Wrap a network promise with a timeout: if the request hasn't settled within `ms`,
 * reject with `net-timeout`. This guarantees that every await in the online layer
 * eventually settles — without it, a stalled request (dropped mid-flight) would hold
 * the promise open forever, and the caller's catch (toast/button recovery) would never
 * fire. Supabase's query builders are thenable, so they wrap as-is.
 */
function withTimeout<T>(p: PromiseLike<T>, ms = NET_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('net-timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Create a game: inserts a row with the track and the host in the lobby. Returns the row. */
export async function createGame(track: Track, hostName: string): Promise<GameRow> {
  const id = makeCode();
  const me = clientId();
  const row = {
    id,
    track: serializeTrack(track),
    state: null,
    lobby: [{ clientId: me, name: hostName }],
    host_id: me,
    status: 'lobby' as const,
  };
  const { data, error } = await withTimeout(
    db().from('games').insert(row).select().single(),
  );
  if (error) {
    // Extremely rare code collision — retry once with a new code.
    if (error.code === '23505') return createGame(track, hostName);
    throw error;
  }
  return data as GameRow;
}

/** Join a game by code (atomically, via RPC). Returns the game row. */
export async function joinGame(code: string, name: string): Promise<GameRow> {
  const { data, error } = await withTimeout(
    db().rpc('join_game', {
      p_code: code,
      p_client_id: clientId(),
      p_name: name,
    }),
  );
  if (error) throw error;
  const row = parseGameRow(data);
  if (!row) throw new Error('bad-game-row');
  return row;
}

/** Fetch the game row by code (null if not found or the data is invalid). */
export async function fetchGame(code: string): Promise<GameRow | null> {
  const { data, error } = await withTimeout(
    db().from('games').select().eq('id', code).maybeSingle(),
  );
  if (error) throw error;
  return parseGameRow(data);
}

/** Write the current race state (after a move or on start). Updates status. */
export async function pushState(code: string, state: GameState): Promise<void> {
  const status = state.phase === 'over' ? 'over' : 'race';
  const { error } = await withTimeout(
    db()
      .from('games')
      .update({
        state: serializeState(state),
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', code),
  );
  if (error) throw error;
}

/** Leave the lobby (atomically): frees the seat, and deletes the game if it's now empty or the host left. */
export async function leaveGame(code: string): Promise<void> {
  await withTimeout(db().rpc('leave_game', { p_code: code, p_client_id: clientId() }));
}

/** Leave the lobby on behalf of another (absent) player: pruning an abandoned seat,
 *  triggered by a client that's still present. Same leave_game RPC, but with someone else's clientId. */
export async function pruneSeat(code: string, absentClientId: string): Promise<void> {
  await withTimeout(
    db().rpc('leave_game', { p_code: code, p_client_id: absentClientId }),
  );
}

/**
 * Subscribe to changes on the game row. onChange gets the new row on INSERT/UPDATE
 * and null when the game is deleted (DELETE — TTL expiry or the host left). If
 * onPresence is given, the channel also runs Realtime Presence: this client marks
 * itself online (keyed by clientId), and onPresence receives the current set of
 * present clientIds on every sync (any participant joining or leaving).
 */
export function subscribeGame(
  code: string,
  onChange: (row: GameRow | null) => void,
  onPresence?: (present: Set<string>) => void,
  onStatus?: (connected: boolean) => void,
): RealtimeChannel {
  const ch = db()
    .channel(`game:${code}`, { config: { presence: { key: clientId() } } })
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'games', filter: `id=eq.${code}` },
      (payload) => {
        if (payload.eventType === 'DELETE') onChange(null);
        else {
          const row = parseGameRow(payload.new);
          // Ignore invalid rows — keep the last valid state; the next valid update
          // (or a resync on SUBSCRIBED → fetchGame) will fix things up.
          if (row) onChange(row);
        }
      },
    );
  if (onPresence) {
    ch.on('presence', { event: 'sync' }, () => {
      onPresence(new Set(Object.keys(ch.presenceState())));
    });
  }
  // supabase-js auto-rejoins the channel after a socket drop, so SUBSCRIBED fires both
  // on the initial subscribe and on every reconnect — we use it as a resync hook
  // (re-track presence + the caller's fetchGame). Error/timeout/close on the channel
  // is our "connection lost" signal for the banner.
  ch.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      if (onPresence) ch.track({ clientId: clientId() });
      onStatus?.(true);
    } else if (
      status === 'CHANNEL_ERROR' ||
      status === 'TIMED_OUT' ||
      status === 'CLOSED'
    ) {
      onStatus?.(false);
    }
  });
  return ch;
}

export function unsubscribe(ch: RealtimeChannel): void {
  db().removeChannel(ch);
}
