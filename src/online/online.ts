// Online session: a thin layer on top of net.ts that holds the current game's state
// (code, roster, host flag, track) and translates incoming realtime rows into
// high-level events for main.ts. Exactly one active session at a time.

import { RealtimeChannel } from '@supabase/supabase-js';
import { Track } from '../model/track';
import { GameState } from '../model/game';
import {
  GameRow,
  RosterEntry,
  clientId,
  createGame,
  fetchGame,
  joinGame,
  leaveGame,
  pruneSeat,
  pushState,
  subscribeGame,
  unsubscribe,
  deserializeTrack,
  deserializeState,
} from './net';

export interface OnlineHandlers {
  /** Lobby roster/status changed (someone joined/left) — refresh the lobby screen. */
  onLobby: () => void;
  /** A race state arrived (start or someone's move) — replace the local game and redraw. */
  onGameState: (game: GameState) => void;
  /** The game was deleted on the server (TTL / host left) — leave online mode. */
  onClosed: () => void;
  /** Presence changed (someone went online/offline) — recompute the timer/skip/labels. */
  onPresence: () => void;
  /** The realtime channel's connection state changed — show/hide the connection banner. */
  onConnection: (connected: boolean) => void;
}

let code: string | null = null;
let channel: RealtimeChannel | null = null;
let roster: RosterEntry[] = [];
let hostFlag = false;
let track: Track | null = null;
let handlers: OnlineHandlers | null = null;
/** clientIds whose tabs are currently online (Realtime Presence). */
let present = new Set<string>();
/** When a clientId dropped out of presence (ms) — marks the start of the auto-skip grace period. */
let leftAt = new Map<string, number>();
/** Whether the realtime channel is currently connected (drives the "no connection" banner). */
let connected = true;

/** Whether an online session is active (a game was created or joined). */
export function active(): boolean {
  return code !== null;
}

/** Whether the realtime channel is currently connected. */
export function isConnected(): boolean {
  return connected;
}

export function getCode(): string | null {
  return code;
}

export function getRoster(): RosterEntry[] {
  return roster;
}

export function isHost(): boolean {
  return hostFlag;
}

export function getTrack(): Track | null {
  return track;
}

/** This client's seat (index) in the roster; −1 if not seated. */
export function mySeat(): number {
  return roster.findIndex((r) => r.clientId === clientId());
}

/** clientId of the seat at this roster index (null if the seat is empty). */
function seatClientId(seat: number): string | null {
  return roster[seat]?.clientId ?? null;
}

/** Whether the player's tab in this seat is online right now. */
export function isPresent(seat: number): boolean {
  const id = seatClientId(seat);
  return id !== null && present.has(id);
}

/** When the player in this seat dropped out of presence (ms), or null if they're online. */
export function leftAtOf(seat: number): number | null {
  const id = seatClientId(seat);
  if (id === null || present.has(id)) return null;
  return leftAt.get(id) ?? null;
}

/**
 * The present client's seat designated to perform auto-skip/pruning — the lowest
 * online seat. This way only one client does the (otherwise duplicate) write
 * (everyone else would write the same state, so there's no point in the extra
 * traffic). −1 means no one is present.
 */
export function designatedSkipper(): number {
  for (let s = 0; s < roster.length; s++) if (isPresent(s)) return s;
  return -1;
}

/** Handle a presence sync: update the online set and leave-timestamps, then notify the handler. */
function handlePresence(next: Set<string>): void {
  present.forEach((id) => {
    if (!next.has(id)) leftAt.set(id, Date.now());
  });
  next.forEach((id) => leftAt.delete(id));
  present = next;
  handlers?.onPresence();
}

/**
 * Handle a realtime channel status change. On (re)connect — resync: fetch the current
 * game row (this covers updates missed during the outage and the gap between the
 * initial fetch and the subscription going live). If the game was deleted in the
 * meantime, fetchGame returns null → applyRow(null) → the normal onClosed path. The
 * banner only fires on an actual state change.
 */
function handleStatus(ok: boolean): void {
  if (!code) return; // after close(), events from the dead channel are no-ops
  if (ok)
    fetchGame(code)
      .then(applyRow)
      .catch(() => {});
  if (connected !== ok) {
    connected = ok;
    handlers?.onConnection(ok);
  }
}

/** The host can start once at least one other player has joined. */
export function canStart(): boolean {
  return hostFlag && roster.length >= 2;
}

/** Handle an incoming game row (from realtime, or the initial fetch). */
function applyRow(row: GameRow | null): void {
  if (!row) {
    close();
    handlers?.onClosed();
    return;
  }
  roster = row.lobby ?? [];
  if (row.state && track) {
    handlers?.onGameState(deserializeState(row.state, track));
  } else {
    handlers?.onLobby();
  }
}

/** Create a game (as host). Returns the game code. */
export async function host(t: Track, name: string, h: OnlineHandlers): Promise<string> {
  const row = await createGame(t, name);
  handlers = h;
  code = row.id;
  hostFlag = true;
  track = t;
  connected = true;
  channel = subscribeGame(code, applyRow, handlePresence, handleStatus);
  applyRow(row);
  return code;
}

/**
 * The name this client is already registered under in the roster of the game with
 * this code (i.e. rejoining an already-active game), or null if the game doesn't
 * exist or this client isn't in its roster. Lets us skip re-asking for a name on reconnect.
 */
export async function memberName(joinCode: string): Promise<string | null> {
  try {
    const row = await fetchGame(joinCode);
    const me = row?.lobby?.find((r) => r.clientId === clientId());
    return me?.name ?? null;
  } catch {
    return null;
  }
}

/** Join a game by code (as guest). */
export async function join(
  joinCode: string,
  name: string,
  h: OnlineHandlers,
): Promise<void> {
  const row = await joinGame(joinCode, name);
  handlers = h;
  code = row.id;
  hostFlag = row.host_id === clientId();
  track = deserializeTrack(row.track);
  connected = true;
  channel = subscribeGame(code, applyRow, handlePresence, handleStatus);
  applyRow(row);
}

/** Start the race (host): write the first state. */
export async function start(game: GameState): Promise<void> {
  if (code) await pushState(code, game);
}

/** Send our move to everyone else. */
export async function pushMove(game: GameState): Promise<void> {
  if (code) await pushState(code, game);
}

/** Remove an abandoned seat from the lobby (by index) — pruning done by a present client. */
export async function prune(seat: number): Promise<void> {
  const id = seatClientId(seat);
  if (code && id) await pruneSeat(code, id);
}

/** Drop our presence immediately (on tab close) — best-effort. */
export function untrack(): void {
  channel?.untrack();
}

/** Leave the session: free the seat on the server and unsubscribe. */
export async function leave(): Promise<void> {
  const c = code;
  close();
  if (c) {
    try {
      await leaveGame(c);
    } catch {
      // Leaving is best-effort — even on a network error, we've already left locally.
    }
  }
}

/** Close the session locally (unsubscribe + reset state). */
function close(): void {
  // Clear code/handlers first, then unsubscribe: the CLOSED status that arrives from
  // removeChannel will pass through handleStatus as a no-op (no code set).
  const ch = channel;
  channel = null;
  code = null;
  handlers = null;
  roster = [];
  hostFlag = false;
  track = null;
  present = new Set();
  leftAt = new Map();
  connected = true;
  if (ch) unsubscribe(ch);
}
