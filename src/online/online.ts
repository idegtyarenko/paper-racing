// Online session: a thin layer on top of net.ts that holds the current game's state
// (code, roster, host flag, track) and translates incoming realtime rows into
// high-level events for main.ts. Exactly one active session at a time.

import { RealtimeChannel } from '@supabase/supabase-js';
import { Track } from '../model/track';
import { GameState, Rules, normalizeRules, seatName } from '../model/game';
import { Difficulty } from '../model/ai';
import { NEVER_SEEN_GRACE_MS } from '../config';
import {
  GameRow,
  RosterEntry,
  SerializedSetup,
  clientId,
  createGame,
  fetchGame,
  isSerializedSetup,
  joinGame,
  leaveGame,
  pruneSeat,
  pushSetup,
  pushState,
  renamePlayer,
  subscribeGame,
  unsubscribe,
  deserializeTrack,
  deserializeState,
  turnStartedAt as readTurnStartedAt,
} from './net';

export interface OnlineHandlers {
  /** Lobby roster/status changed (someone joined/left) — refresh the lobby screen. */
  onLobby: () => void;
  /** A race state arrived (start or someone's move) — replace the local game and redraw. */
  onGameState: (game: GameState) => void;
  /** The game was deleted on the server (TTL / host left) — leave online mode. */
  onClosed: () => void;
  /** Someone else left for good — in the lobby their seat is gone, in a race it's
   *  flagged. Fires on every remaining client so the departure can be announced. */
  onPlayerLeft: (name: string) => void;
  /** The host changed the race setup while we wait in the lobby (guests only —
   *  the host is the one who changed it). Both sides are passed so the announcement
   *  can name what actually moved. */
  onSetupChanged: (before: LobbySetup, after: LobbySetup) => void;
  /** Presence changed (someone went online/offline) — recompute the timer/skip/labels. */
  onPresence: () => void;
  /** The realtime channel's connection state changed — show/hide the connection banner. */
  onConnection: (connected: boolean) => void;
}

/** The host's setup as this client knows it: rules normalized, bots as chosen. */
export interface LobbySetup {
  rules: Rules;
  bots: { count: number; difficulty: Difficulty };
}

let code: string | null = null;
let channel: RealtimeChannel | null = null;
let roster: RosterEntry[] = [];
let hostFlag = false;
/** clientId of the game's creator — marks the HOST badge in the roster. */
let hostClient: string | null = null;
let track: Track | null = null;
let handlers: OnlineHandlers | null = null;
/** clientIds whose tabs are currently online (Realtime Presence). */
let present = new Set<string>();
/** When a clientId dropped out of presence (ms) — marks the start of the auto-skip grace period. */
let leftAt = new Map<string, number>();
/** When a clientId first turned up in the roster without ever having been in presence (ms).
 *  A seat that has never shown up is not the same as one that left: the roster row arrives on
 *  a row update, the presence message a moment later. */
let firstSeen = new Map<string, number>();
/** Pending repaint for a grace period running out (the lobby has no tick of its own). */
let firstSeenTimer: number | null = null;
/** Whether the realtime channel is currently connected (drives the "no connection" banner). */
let connected = true;
/** When the current turn began, per the client that wrote the move (null if unknown),
 *  together with the turn number it belongs to — a stamp only counts for its own turn. */
let turnStart: number | null = null;
let turnStartFor = -1;
/** The host's setup as it last arrived on the row — null until a row carries one
 *  (an old client's game, or a race that started before we joined). */
let lobbySetup: LobbySetup | null = null;

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

/**
 * The roster without the players who left mid-race. Use this to build a lineup (who
 * actually races next); use `getRoster` where the index matters, since it's the seat.
 */
export function activeRoster(): RosterEntry[] {
  return roster.filter((r) => !r.left);
}

export function isHost(): boolean {
  return hostFlag;
}

/** clientId of the game's creator (null outside a session). */
export function hostId(): string | null {
  return hostClient;
}

/**
 * Whether the creator has walked out of this room for good. Leaving a race that has
 * already started doesn't delete the game row (the RPC only flags the seat), so the
 * room outlives its creator — and with it, everything that only they could start.
 */
export function hostGone(): boolean {
  return hostClient !== null && !roster.some((r) => r.clientId === hostClient && !r.left);
}

/** The creator's seat (index) in the roster; −1 if they're no longer in it. Their
 *  presence is what the others' race hangs on — only their client moves the bots. */
export function hostSeat(): number {
  return hostClient === null ? -1 : roster.findIndex((r) => r.clientId === hostClient);
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

/**
 * Whether this seat should be drawn as offline. Differs from `!isPresent` in that a seat
 * we have never yet seen online reads as an ordinary one for a short while — its roster
 * row arrives ahead of its presence message, and marking it offline in that gap makes a
 * player who is right there blink "offline". Presentation only: `isPresent` stays strict,
 * so auto-skip and pruning are unaffected.
 */
export function showsOffline(seat: number): boolean {
  if (isPresent(seat)) return false;
  const id = seatClientId(seat);
  if (id === null) return false;
  const since = firstSeen.get(id);
  return since === undefined || Date.now() - since >= NEVER_SEEN_GRACE_MS;
}

/**
 * When the current turn began (ms, wall clock), as stamped by whoever wrote the move —
 * null if that row predates the stamp or the clocks disagree. Shared so that a client
 * arriving mid-turn sees the same countdown as everyone else, instead of a fresh one.
 */
export function turnStartedAt(turn: number): number | null {
  return turnStartFor === turn ? turnStart : null;
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
  next.forEach((id) => {
    leftAt.delete(id);
    // Seen at last — from here on `leftAt` tells their story, not the grace period.
    firstSeen.delete(id);
  });
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

/**
 * Announce anyone who left between two rosters. A departure looks different either
 * side of the start: in the lobby the entry is dropped, in a race it's flagged (the
 * index is the grid slot, so it can't be dropped). Our own leave never reaches here —
 * `leave()` closes the session before the write — but skip ourselves anyway, since a
 * seat can also be pruned on our behalf.
 */
function announceDepartures(before: RosterEntry[], after: RosterEntry[]): void {
  if (!before.length) return; // first row of a session: everyone is arriving, not leaving
  const me = clientId();
  before.forEach((was, seat) => {
    if (was.clientId === me || was.left) return;
    const now = after.find((r) => r.clientId === was.clientId);
    if (now && !now.left) return;
    handlers?.onPlayerLeft(was.name || seatName(seat));
  });
}

/**
 * Take the host's setup off an incoming row and announce a change of it. Silent on
 * the first one we see (arriving in a lobby isn't a change), silent for the host
 * (they are the one who moved it), and silent on a row that carries none — a guest
 * whose host runs an older client keeps showing nothing rather than something stale.
 */
function applySetup(row: GameRow): void {
  if (!isSerializedSetup(row.setup)) return;
  const next: LobbySetup = {
    rules: normalizeRules(row.setup.rules),
    bots: { ...row.setup.bots },
  };
  const before = lobbySetup;
  lobbySetup = next;
  if (before && !hostFlag) handlers?.onSetupChanged(before, next);
}

/**
 * Start the grace period for roster seats we have never seen in presence, and drop the
 * bookkeeping for seats that are gone. If any grace is now running, arm a repaint for when
 * it expires: a seat whose presence never arrives has to settle into "offline" on its own,
 * and the lobby has no tick to do it (turn-watch's only runs during a race).
 */
function noteUnseen(): void {
  const ids = new Set(roster.map((r) => r.clientId));
  firstSeen.forEach((_, id) => {
    if (!ids.has(id)) firstSeen.delete(id);
  });
  ids.forEach((id) => {
    if (!present.has(id) && !leftAt.has(id) && !firstSeen.has(id))
      firstSeen.set(id, Date.now());
  });
  armUnseenTimer();
}

/**
 * Arm the repaint for the first grace period still running (entries whose grace has already
 * expired keep their timestamp — re-adding them in `noteUnseen` would hand a long-gone seat a
 * fresh grace). No timer when nothing is pending, so this never loops.
 */
function armUnseenTimer(): void {
  if (firstSeenTimer !== null) return;
  const now = Date.now();
  let earliest = Infinity;
  firstSeen.forEach((at) => {
    if (at + NEVER_SEEN_GRACE_MS > now) earliest = Math.min(earliest, at);
  });
  if (earliest === Infinity) return;
  firstSeenTimer = window.setTimeout(
    () => {
      firstSeenTimer = null;
      armUnseenTimer();
      handlers?.onPresence();
    },
    earliest + NEVER_SEEN_GRACE_MS - now,
  );
}

/** Handle an incoming game row (from realtime, or the initial fetch). */
function applyRow(row: GameRow | null): void {
  if (!row) {
    close();
    handlers?.onClosed();
    return;
  }
  const before = roster;
  roster = row.lobby ?? [];
  noteUnseen();
  announceDepartures(before, roster);
  applySetup(row);
  if (row.state && track) {
    // Before the handler: arming the turn watch is downstream of onGameState, and it
    // reads this to tell how much of the turn is already gone.
    turnStart = readTurnStartedAt(row.state);
    turnStartFor = row.state.turn ?? 0;
    handlers?.onGameState(deserializeState(row.state, track));
  } else {
    handlers?.onLobby();
  }
}

/** The host's setup as this client last saw it (null: none has arrived). */
export function getLobbySetup(): LobbySetup | null {
  return lobbySetup;
}

/** Host: write the current setup onto the row. Guests never call this. */
export async function writeSetup(setup: SerializedSetup): Promise<void> {
  if (!code || !hostFlag) return;
  await pushSetup(code, setup);
}

/** Create a game (as host). Returns the game code. */
export async function host(
  t: Track,
  name: string,
  setup: SerializedSetup,
  h: OnlineHandlers,
): Promise<string> {
  const row = await createGame(t, name, setup);
  handlers = h;
  code = row.id;
  hostFlag = true;
  hostClient = row.host_id;
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
  hostClient = row.host_id;
  track = deserializeTrack(row.track);
  connected = true;
  channel = subscribeGame(code, applyRow, handlePresence, handleStatus);
  applyRow(row);
}

/**
 * Our own name, as typed — applied to the local roster right away so the screen never
 * lags behind the keyboard (the write to the server is debounced, see setName in the
 * controller, and its echo confirms the same value later).
 */
export function setLocalName(name: string): void {
  const seat = mySeat();
  if (seat >= 0) roster[seat] = { ...roster[seat], name };
}

/** Push our name to the lobby roster on the server. */
export async function rename(name: string): Promise<void> {
  if (code) await renamePlayer(code, name);
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

/**
 * Announce our presence again after coming back from the background — best-effort.
 * `untrack()` runs on every `pagehide`, but the matching `track()` lives in the
 * SUBSCRIBED branch, i.e. it only fires on a reconnect. A background long enough to
 * kill the socket therefore heals itself; one the socket survives would leave us
 * invisible to everyone else for the rest of the game, with our turns auto-skipped.
 */
export function retrack(): void {
  // Fire-and-forget: track() reports failure by resolving to 'error'/'timed out'
  // rather than rejecting, and there is nothing useful to do about it here — a
  // reconnect re-tracks us through the SUBSCRIBED branch.
  void channel?.track({ clientId: clientId() });
}

/**
 * Free our seat on the server while staying subscribed. Called before retiring on the
 * way out of a running race, so the others learn we're gone *before* the retirement
 * lands and can announce the departure instead of a surrender. Idempotent: `leave()`
 * calls the same RPC again afterwards, and flagging an already-flagged seat is a no-op.
 *
 * Only meaningful once a race exists — in the lobby the same RPC drops the seat (and
 * may delete the room), and we'd receive the echo of our own removal as `onClosed`.
 */
export async function markLeft(): Promise<void> {
  if (!code) return;
  try {
    await leaveGame(code);
  } catch {
    // Best-effort: leaving must not be blocked by a failed write.
  }
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
  hostClient = null;
  track = null;
  present = new Set();
  leftAt = new Map();
  firstSeen = new Map();
  if (firstSeenTimer !== null) clearTimeout(firstSeenTimer);
  firstSeenTimer = null;
  connected = true;
  turnStart = null;
  turnStartFor = -1;
  lobbySetup = null;
  if (ch) unsubscribe(ch);
}
