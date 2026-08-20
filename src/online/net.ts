// Network layer for online mode: the Supabase client and the operations on the game
// row. No DOM here — just transport. How a track and a race state turn into JSON is the
// model's business (`model/serialize.ts`); this file adds only what the wire needs.
//
// Model is "shared state, mover writes it": the active player applies their move
// locally and writes the game row; everyone else picks up the change via the realtime subscription.

import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { Track } from '../model/track';
import { GameState, Rules } from '../model/game';
import {
  SerializedState,
  SerializedTrack,
  serializeState,
  serializeTrack,
  isObj,
  isSerializedState,
  isSerializedTrack,
} from '../model/serialize';
import { Difficulty } from '../model/ai';
import { CLOCK_SANITY_MS, NET_TIMEOUT_MS } from '../config';

// ── The wire format ─────────────────────────────────────────────────────────────
//
// The shared part — how a track and a race state become JSON — belongs to the model
// (`model/serialize.ts`), because the local snapshot serializes the same things. What
// is added here is what only the wire needs.

/**
 * A race state on the wire: the model's snapshot plus the wall-clock moment the row was
 * written — which, since a row is written exactly when a move lands, is the moment the
 * turn on it began. It rides the wire rather than `GameState` on purpose: the model
 * stays free of clocks, and a client arriving mid-turn (a reload, a reopened tab) can
 * still tell how much of it is left.
 */
export type NetState = SerializedState & { turnStartedAt?: number };

/** Serialize for the wire: the model's snapshot, stamped with our clock. */
export function stampState(g: GameState): NetState {
  return { ...serializeState(g), turnStartedAt: Date.now() };
}

/**
 * The host's pre-race setup as it travels on the row: the rules, and the bot fill
 * the host has dialled in. Rules also travel inside the state once the race is on —
 * but `state` is null in the lobby, which is exactly when a guest wants to know what
 * they're waiting to race under. Bots have no other home at all before the start
 * (the host keeps the count locally and materializes it in buildStartState).
 *
 * Rules are `Partial` on the way in: a row may have been written by an older client,
 * and normalizeRules backfills whatever is missing.
 */
export interface SerializedSetup {
  rules: Partial<Rules>;
  bots: { count: number; difficulty: Difficulty };
}

export interface RosterEntry {
  clientId: string;
  name: string;
  /** Set once the player leaves a race in progress. The entry itself has to stay —
   *  its index is the grid slot — so `leave_game` flags it instead of removing it,
   *  and the next race is built from the entries without this flag. */
  left?: boolean;
}

export interface GameRow {
  id: string;
  track: SerializedTrack;
  state: NetState | null;
  lobby: RosterEntry[];
  /** The host's setup (see SerializedSetup). Absent on rows written before it travelled. */
  setup?: SerializedSetup | null;
  host_id: string;
  status: 'lobby' | 'race' | 'over';
}

/**
 * When the turn in this state began, by the writer's clock — null on rows written
 * before the stamp existed, and on anything that reads as nonsense: a stamp from the
 * future, or one so old it can only mean the two clocks disagree (an ordinary overrun
 * is kept, so the turn reads as expired rather than starting over). Callers fall back
 * to their own clock, which is what every client did before this travelled.
 */
export function turnStartedAt(s: NetState): number | null {
  const at = s.turnStartedAt;
  if (typeof at !== 'number') return null;
  const elapsed = Date.now() - at;
  return elapsed < 0 || elapsed > CLOCK_SANITY_MS ? null : at;
}

// ── Validating incoming rows ────────────────────────────────────────────────────
//
// A row from the network arrives as `unknown`. The track and the state inside it are
// shape-checked by the model's guards (`model/serialize.ts`); what is checked here is
// the envelope around them — the fields a row has because it is a row.

/**
 * Shape of the host's setup. A malformed one doesn't invalidate the row (the race
 * itself doesn't depend on it — it's what the lobby shows), so callers read it
 * through this guard and fall back to "no settings known".
 */
export function isSerializedSetup(v: unknown): v is SerializedSetup {
  if (!isObj(v) || !isObj(v.rules) || !isObj(v.bots)) return false;
  return typeof v.bots.count === 'number' && typeof v.bots.difficulty === 'string';
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

let restWatcher: ((ok: boolean) => void) | null = null;

/**
 * Listen in on whether requests are reaching the server. Every REST operation here
 * goes through `withTimeout`, so that one place sees them all — no need to instrument
 * the dozen call sites that each handle their own failure.
 */
export function watchRest(cb: ((ok: boolean) => void) | null): void {
  restWatcher = cb;
}

/**
 * Did this response come from the server at all?
 *
 * Rejecting is NOT how a postgrest builder reports a dead network: unless you ask for
 * `.throwOnError()` (we don't), it catches the fetch failure and RESOLVES with an
 * error object instead — so a resolved promise proves nothing on its own. What it does
 * leave behind is `status: 0`, which a real reply never has: every answer PostgREST
 * gets to send carries an HTTP status, refusals (RLS, a unique clash, no such row)
 * included. Those are the server talking, and they mean the link is fine.
 */
function reachedServer(v: unknown): boolean {
  return !(
    typeof v === 'object' &&
    v !== null &&
    'status' in v &&
    (v as { status: unknown }).status === 0
  );
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
    // A request is worth exactly one verdict. Timing out doesn't cancel the request,
    // so a black-holed one can still settle minutes later; without this, that late
    // answer would overturn a verdict the player has already been shown.
    let reported = false;
    const report = (ok: boolean): void => {
      if (reported) return;
      reported = true;
      restWatcher?.(ok);
    };
    const t = setTimeout(() => {
      // The hung request — nothing came back at all, which is the very case the
      // banner exists for. It reaches none of the handlers below, so report here.
      report(false);
      reject(new Error('net-timeout'));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        report(reachedServer(v));
        resolve(v);
      },
      (e) => {
        // The builder itself rejected — rare, since it turns fetch failures into
        // resolved error objects instead (see reachedServer).
        clearTimeout(t);
        report(false);
        reject(e);
      },
    );
  });
}

/** Create a game: inserts a row with the track, the host in the lobby and their
 *  chosen setup (so a guest joining a second later already sees the settings). */
export async function createGame(
  track: Track,
  hostName: string,
  setup: SerializedSetup,
): Promise<GameRow> {
  const id = makeCode();
  const me = clientId();
  const row = {
    id,
    track: serializeTrack(track),
    state: null,
    lobby: [{ clientId: me, name: hostName }],
    setup,
    host_id: me,
    status: 'lobby' as const,
  };
  const { data, error } = await withTimeout(
    db().from('games').insert(row).select().single(),
  );
  if (error) {
    // Extremely rare code collision — retry once with a new code.
    if (error.code === '23505') return createGame(track, hostName, setup);
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

/**
 * Rename ourselves in the lobby (atomically, via RPC): rewrites just our own roster
 * entry. Fired while the player types, so it's deliberately fire-and-forget — the
 * authoritative name comes back through the realtime update like any other change.
 */
export async function renamePlayer(code: string, name: string): Promise<void> {
  const { error } = await withTimeout(
    db().rpc('rename_player', {
      p_code: code,
      p_client_id: clientId(),
      p_name: name,
    }),
  );
  if (error) throw error;
}

/**
 * Write the host's setup onto the lobby row. Fire-and-forget from the caller's point
 * of view, like renamePlayer: it's fired while the host drags a slider, and the
 * authoritative value comes back through the realtime update anyway.
 */
export async function pushSetup(code: string, setup: SerializedSetup): Promise<void> {
  const { error } = await withTimeout(
    db().from('games').update({ setup }).eq('id', code),
  );
  if (error) throw error;
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
        state: stampState(state),
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
