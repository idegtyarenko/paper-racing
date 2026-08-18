// Single source of truth for app state. It used to live as a dozen module-level
// `let`s in main.ts, with online/input reaching them through dozens of get/set
// shims. Now it's one object: main.ts owns it, and online-controller and input
// read and mutate it by reference (`deps.state.game = …`). Non-data handles
// (like the bot-move timer) don't belong here — this holds data only. Saving
// (persist.ts) serializes a subset of it.
//
// The cross-layer types `Phase` and `LastLocalRace` also live here: without
// this, persist/view/online would each have to pull in `ui/panel` just for
// one type (an unnecessary edge in the module graph).

import { EditorState, newEditor } from './model/editor';
import { Track } from './model/track';
import { GameState, Candidate, Rules, DEFAULT_RULES } from './model/game';
import { NavField } from './model/nav';
import { Difficulty } from './model/ai';

/** App screen/phase: track drawing, mode/player-count/bot-difficulty
 *  selection, lobby, race. */
export type Phase = 'edit' | 'modeSelect' | 'players' | 'ai' | 'lobby' | 'race';

/** Last local lineup — powers "Same track" as a one-tap restart. Covers both
 *  hotseat (bots 0) and vs-computer (humans 1). */
export type LastLocalRace = { humans: number; bots: number; difficulty: Difficulty };

/** App state — the single source of truth for main/online/input. */
export interface AppState {
  /** Current screen/phase. */
  phase: Phase;
  /** State of the track-drawing wizard. */
  editor: EditorState;
  /**
   * A finished track waiting on player-count selection (the "players" step).
   * Comes either from the editor after direction is chosen, or from
   * "New race → same track".
   */
  raceTrack: Track | null;
  /** Where "Back" from the player-select step returns to: editor or race. */
  playersReturn: 'edit' | 'race';
  /**
   * Last local lineup (humans + bots + difficulty) — so "Same track" starts
   * with one tap, without going through the wizard again. Online races don't
   * populate this: rematching the same lineup online is a separate feature.
   */
  lastLocalRace: LastLocalRace | null;
  /** The current race. null when not racing. */
  game: GameState | null;
  /** Move candidates for the seat that currently owns the fan. null when
   *  there's no fan. */
  cands: Candidate[] | null;
  /**
   * Pending move pick: a candidate picked by the local seat during someone
   * else's turn (online/vs-bots), waiting for manual "Go!" confirmation on
   * your own turn. Lives here rather than in input.selected, which is
   * transient and gets cleared on every refreshCands. null means no pick.
   */
  pending: Candidate | null;
  /** Race rules chosen in settings. In online play, the host sets these. */
  rules: Rules;
  /**
   * Navigation field for the current race's track (distances to the finish).
   * Needed by bots (chooseMove) and by the current-standings strip
   * (renderStandings). null when not racing.
   */
  raceNav: NavField | null;
}

/** Fresh app state: a blank editor, default rules. */
export function newAppState(): AppState {
  return {
    phase: 'edit',
    editor: newEditor(),
    raceTrack: null,
    playersReturn: 'edit',
    lastLocalRace: null,
    game: null,
    cands: null,
    pending: null,
    rules: { ...DEFAULT_RULES },
    raceNav: null,
  };
}

// ── Online view-models ────────────────────────────────────────────────────────
// The lobby and the race's online strip are filled in by `online/` and drawn by
// `ui/`. Declaring them in the UI module that happens to draw them made the
// network layer import `ui/` for a type, so a lobby redesign reached into the
// controller. They live here for the same reason Phase does: a neutral house
// both sides can read from.

/** One racer as the roster shows them. `name` may be empty — see renderRoster. */
export interface RosterPlayer {
  name: string;
  color: string;
  /** This client's own seat: its name is editable in place. */
  you: boolean;
  /** Marked with the HOST badge (the client that owns the track). */
  host: boolean;
  /** Not currently connected — the row dims and says so. */
  offline: boolean;
  /** A bot seat the host has filled: badged with its difficulty instead of a
   *  status. Only a guest's roster shows these — see lobbyView in host-bots.ts. */
  bot?: Difficulty;
}

/**
 * Everything a lobby screen draws. Assembled in one place (online/host-bots.ts)
 * from the session, and rendered by whichever screen is showing: the host's
 * lobby is the race-setup card's Lineup tab, the guest's is its own screen.
 */
export interface LobbyView {
  code: string;
  players: RosterPlayer[];
  /** The race settings chosen by the host, for the guest's read-only tabs. Null
   *  when none have arrived (a host on an older client). */
  rules: Rules | null;
  /** Seats on this track's starting grid — the roster's capacity. */
  seats: number;
  isHost: boolean;
  /** Enough racers have joined for the host to start. */
  canStart: boolean;
  /** Our own name is still empty — the one thing holding the host back. */
  needsName: boolean;
  /** Host-local bot fill (only the host sets these). */
  botCount: number;
  maxBots: number;
  botDifficulty: Difficulty;
  /** Realtime channel is up — false puts the status banner into its error skin. */
  connected: boolean;
  /** The host's start write is in flight. */
  starting: boolean;
}

/** Online context for the current turn — the same object the panel used. */
export interface NetTurn {
  yourTurn: boolean;
  /** Show the skip button: the active player is online but hasn't moved past the timeout. */
  canSkip: boolean;
  /** Name of the player whose turn it is (for the skip-related status). */
  currentName: string;
  /** Presence by seat (index = seat); false means that tab is offline. */
  present: boolean[];
  /** Code of the current online race — the chip lets a disconnected player back in. */
  code: string;
  /** Whether this client is the track's creator (can trigger a rematch). */
  isHost: boolean;
}

/** State of sending a move online: idle / sending / send failed. */
export type SendState = 'idle' | 'sending' | 'failed';
