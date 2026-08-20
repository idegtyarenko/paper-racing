// Saves local game state to localStorage so that a page reload (swipe-to-
// reload, a "back" button/gesture, backgrounding the tab on a phone) doesn't
// reset the game to the initial track-drawing screen. Online play doesn't go
// through this — its session lives on the server and is restored its own way.

import { AppState, Phase, LastLocalRace } from './app-state';
import { EditorState, EditorStep, stepPrompt } from './model/editor';
import { Track } from './model/track';
import { GameState, Rules, normalizeRules } from './model/game';
import { buildNavField } from './model/nav';
import {
  SerializedTrack,
  SerializedState,
  serializeTrack,
  deserializeTrack,
  serializeState,
  deserializeState,
  isObj,
  isSerializedTrack,
  isSerializedState,
} from './model/serialize';

const KEY = 'pr-local-state';
// v3: which seats are bots moved into the state itself (Player.bot) — there's
// no separate `ai` field anymore, and lastLocalRace holds the lineup
// (humans+bots+difficulty). Older snapshots (v2, with a side-channel `ai` /
// the old lastLocalRace shape) are incompatible — we discard them.
const VERSION = 3;

/** A live snapshot of local app state (what main.ts holds). Bot seats travel
 *  inside game.players (Player.bot) — there's no separate field for bots. */
export interface LocalSnapshot {
  phase: Phase;
  editor: EditorState;
  raceTrack: Track | null;
  game: GameState | null;
  rules: Rules;
  playersReturn: 'edit' | 'race';
  lastLocalRace: LastLocalRace | null;
}

/** The JSON shape of a snapshot: tracks with a `inside` Set are flattened
 *  into arrays. */
interface Stored {
  v: number;
  phase: Phase;
  editor: EditorState;
  raceTrack: SerializedTrack | null;
  game: { track: SerializedTrack; state: SerializedState } | null;
  rules: Rules;
  playersReturn: 'edit' | 'race';
  lastLocalRace: LastLocalRace | null;
}

/** Write a snapshot. Takes the whole app state but only persists the
 *  persistent subset (cands/pending/raceNav are derived and not written).
 *  Write errors (quota exceeded / private browsing) are silently swallowed. */
export function save(snap: AppState): void {
  try {
    const stored: Stored = {
      v: VERSION,
      phase: snap.phase,
      editor: snap.editor,
      raceTrack: snap.raceTrack ? serializeTrack(snap.raceTrack) : null,
      game: snap.game
        ? { track: serializeTrack(snap.game.track), state: serializeState(snap.game) }
        : null,
      rules: snap.rules,
      playersReturn: snap.playersReturn,
      lastLocalRace: snap.lastLocalRace,
    };
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // localStorage unavailable or full — just skip saving.
  }
}

/** Shape-check a snapshot read from localStorage: it used to be that
 *  `JSON.parse(raw) as Stored` just took the cast on faith. We verify the
 *  skeleton (version/phase/editor/rules plus the shape of tracks and state)
 *  before handing off to deserialize — otherwise a corrupted or foreign
 *  string would flow into state and produce a white screen. This is a shape
 *  check, not a migration; normalization is deserialize's job. */
function isStored(v: unknown): v is Stored {
  if (!isObj(v)) return false;
  if (typeof v.v !== 'number') return false;
  // The screen field was renamed mode→phase within v3 itself — we read older
  // snapshots via the legacy `mode` key so an in-progress race doesn't get
  // reset on update.
  if (typeof (v.phase ?? v.mode) !== 'string') return false;
  if (!isObj(v.editor)) return false;
  if (!isObj(v.rules)) return false;
  if (v.raceTrack !== null && !isSerializedTrack(v.raceTrack)) return false;
  if (v.game !== null) {
    if (!isObj(v.game)) return false;
    if (!isSerializedTrack(v.game.track) || !isSerializedState(v.game.state))
      return false;
  }
  return true;
}

/** Erase the saved snapshot (going into online play / corrupted data). */
export function clear(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // unavailable — no big deal.
  }
}

/** Read and restore a snapshot; null if there isn't one or it's incompatible. */
export function load(): LocalSnapshot | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isStored(parsed)) return null;
    const s = parsed;
    if (s.v !== VERSION) return null;
    // Screen: the new `phase` key, falling back to the legacy `mode` from
    // older v3 snapshots.
    const phase = (s.phase ??
      (parsed as unknown as Record<string, unknown>).mode) as Phase;
    // An online lobby isn't restored locally — ignore a snapshot in that mode.
    if (phase === 'lobby') return null;
    // Don't restore a finished race: there's no point returning to the
    // winner screen, and after a reload it's more honest to start from a
    // clean editor (so we ignore the snapshot).
    if (s.game?.state.phase === 'over') return null;
    const editor = sanitizeEditor(s.editor);
    const raceTrack = s.raceTrack ? deserializeTrack(s.raceTrack) : null;
    const game = s.game
      ? deserializeState(s.game.state, deserializeTrack(s.game.track))
      : null;
    return {
      phase,
      editor,
      raceTrack,
      game,
      rules: s.rules,
      playersReturn: s.playersReturn ?? 'edit',
      lastLocalRace: s.lastLocalRace ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Reset an in-progress editor gesture: the snapshot might have been taken
 * mid-stroke or mid-edge-drag (the tab was backgrounded in the middle of a
 * gesture), and pointerUp will never arrive after a reload.
 *
 * The error state goes with it. A gesture cut short by the system (an iOS
 * home-indicator swipe on the drawing screen) ends in `pointerCancel`, which
 * fails the editor with a "gesture cancelled" toast — and that message belongs
 * to the session that was interrupted. Restoring it means the app re-opens
 * showing an error about something the player never did.
 */
function sanitizeEditor(e: EditorState): EditorState {
  // The wizard step was renamed phase→step — we read older snapshots via the
  // legacy key.
  const rec = e as unknown as Record<string, unknown>;
  const step = (rec.step ?? rec.phase) as EditorStep;
  return {
    ...e,
    step,
    error: false,
    message: stepPrompt(step),
    drawing: false,
    stroke: [],
    dragStart: null,
    dragEnd: null,
    dragEdge: null,
    dragIndex: null,
  };
}

/**
 * Save, or deliberately don't: an online session lives on the server and is
 * restored its own way, so being in one means clearing whatever local snapshot
 * is on disk rather than writing over it. `online` arrives as a flag so this
 * module doesn't have to know the online layer exists.
 */
export function saveAppState(state: AppState, online: boolean): void {
  if (online) {
    clear();
    return;
  }
  save(state);
}

/**
 * Restore local state in place from a snapshot, and report which phase it came
 * back into (null when there was nothing saved). The other half of the round
 * trip `save` starts — kept here with the snapshot format it has to know about.
 */
export function restoreAppState(state: AppState): Phase | null {
  const snap = load();
  if (!snap) return null;
  state.phase = snap.phase;
  state.editor = snap.editor;
  state.raceTrack = snap.raceTrack;
  state.game = snap.game;
  // Backfill defaults: the snapshot may have been written by an older
  // version without newer rules fields (e.g. turnLimitMs) — otherwise
  // they'd come out undefined. This is the same fix net.ts applies to
  // server state on deserialization.
  state.rules = normalizeRules(snap.rules);
  state.playersReturn = snap.playersReturn;
  state.lastLocalRace = snap.lastLocalRace;
  // The nav field isn't serialized — rebuild it from the track (needed by
  // bots and the standings strip). Bot-ness of seats travels inside
  // game.players (Player.bot) — not restored separately.
  if (state.game) state.raceNav = buildNavField(state.game.track);
  return snap.phase;
}
