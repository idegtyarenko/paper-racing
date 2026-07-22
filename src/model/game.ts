// Game engine — the shared core: race state, rules, computing the outcome of a single
// move (crash, finish, new pos/vel/trail), returning from a penalty, and determining
// the winner. Pure logic, no DOM. Turn ordering lives in turns.ts.

import { Vec, dist, lerp, distPointToPolyline, segSegIntersection } from '../geometry';
import { Track, key, unkey, sideOfFinish, onRoad } from './track';
import type { Difficulty } from './ai/difficulty';
import { strings } from '../i18n';
import {
  MIN_PLAYERS,
  WIN_CROSSINGS,
  CRASH_SKIP_TURNS,
  CRASH_PENALTY_MAX,
  OFFROAD_FORGIVE,
  CRASH_SAMPLE_STEP,
  TURN_TIMEOUT_MS,
  DRIVE_PRESETS,
} from '../config';

export interface TrailSeg {
  from: Vec;
  to: Vec;
  /** true means a "teleport" jump to the return point after a crash (drawn as a dashed line). */
  jump: boolean;
}

export interface Player {
  name: string;
  color: string;
  pos: Vec;
  vel: Vec;
  trail: TrailSeg[];
  crashes: Vec[];
  skipTurns: number;
  /** Signed count of finish-line crossings: +1 going forward, -1 going backward. */
  crossings: number;
  finishOvershoot: number | null;
  /**
   * Final position (1-based), assigned once the round in which this car finished
   * gets resolved; null while still racing / retired / finished-but-round-not-resolved
   * yet. Ties are shared when cars cross the line at the same overshoot depth
   * ("1224" scoring: two seconds are followed by a fourth).
   */
  place: number | null;
  /** Player has retired — out of the race, doesn't occupy a place and doesn't take turns. */
  retired: boolean;
  /**
   * Seat is controlled by a bot of this difficulty; undefined means a human owns
   * the seat. Stored on the model itself (not as a side channel) so it travels
   * with the state everywhere: through online sync (guests see the bots) and into
   * the local persisted snapshot — no separate serialization needed since
   * serializeState structurally copies every player field. Bot moves are computed
   * by chooseMove; in online play only the host commits them (see online-controller).
   */
  bot?: Difficulty;
}

// Number of finish crossings needed to win (see WIN_CROSSINGS in config) — re-exported.
export { WIN_CROSSINGS };

/**
 * Car handling: the three mechanical semi-axes of the "traction ellipse" (cells per
 * move) — forward acceleration (accel), braking (brake), lateral grip (grip) —
 * plus aerodynamic downforce, which grows with the square of speed and adds to
 * grip/brake (see aeroFactor and reachableTargets in turns.ts, and the
 * DRIVE_PRESETS presets in config).
 */
export interface Drive {
  accel: number;
  brake: number;
  grip: number;
  downforce: number;
}

/**
 * Race rule settings. In online play these are set by the host and travel with
 * the state (rules is part of GameState, and the whole state except track gets
 * serialized), so every player ends up applying the same rules.
 */
export interface Rules {
  /** How to compute the off-track penalty: 'dynamic' scales with speed, 'static' is fixed. */
  penalty: 'dynamic' | 'static';
  /** Penalty size in turns for the static penalty mode. */
  staticTurns: number;
  /** Exponent ("harshness") of the dynamic penalty formula. */
  dynamicExponent: number;
  /**
   * Car handling (used for move generation, see reachableTargets in turns.ts): three
   * independent semi-axes of the "traction ellipse" in cells per move — forward
   * acceleration, braking, and lateral maneuvering. Equal on all three gives an
   * isotropic circle (classic 3x3); anisotropy produces racing-style trajectories.
   * Presets live in DRIVE_PRESETS in config. The bot plays under the same model
   * (the planner calls reachableTargets too) — there's no separate "classic mode
   * for bots".
   */
  drive: Drive;
  /**
   * Per-turn time limit in ms. Only matters online: once it elapses, a present
   * but stalling player's turn becomes available for others to skip manually,
   * and an absent player's turn is auto-skipped by the assigned client (see
   * armTurnWatch in online-controller.ts). Has no effect in hotseat or vs-bot play.
   */
  turnLimitMs: number;
}

/** Default rules: dynamic penalty at standard (linear) harshness, realistic handling. */
export const DEFAULT_RULES: Rules = {
  penalty: 'dynamic',
  staticTurns: CRASH_SKIP_TURNS,
  dynamicExponent: 1,
  drive: { ...DRIVE_PRESETS.sports },
  turnLimitMs: TURN_TIMEOUT_MS,
};

/**
 * Bring (partial) rules from state/snapshot up to a complete Rules object, backfilling
 * defaults and migrating legacy drive fields. Used at every deserialization point
 * (online state, restoring from persist) so old snapshots come back up correctly.
 * Migrates: the legacy physics field ('classic'|'realistic') into drive; the old
 * maneuver axis into grip; a missing downforce into 0. drive is assembled field by
 * field (not cloned wholesale), otherwise new fields absent from an old snapshot
 * would come out undefined (-> NaN in the ellipse). The result is a fresh object
 * unrelated to the source snapshot (settings screens mutate it in place).
 */
export function normalizeRules(
  partial: (Partial<Rules> & { physics?: string }) | undefined,
): Rules {
  const { physics, ...rest } = partial ?? {};
  // Legacy physics string: 'realistic' was the old {1,2,2} set (no longer a preset,
  // now settles as "Custom"); 'classic' is the current preset.
  const legacy: Partial<Drive> =
    physics === 'realistic'
      ? { accel: 1, brake: 2, grip: 2, downforce: 0 }
      : physics === 'classic'
        ? { ...DRIVE_PRESETS.classic }
        : {};
  const merged = { ...DEFAULT_RULES, ...rest };
  const d = DEFAULT_RULES.drive;
  // Source may be partial/legacy (old maneuver field, no downforce).
  const src = (rest.drive ?? legacy) as Partial<Drive> & { maneuver?: number };
  merged.drive = {
    accel: src.accel ?? d.accel,
    brake: src.brake ?? d.brake,
    grip: src.grip ?? src.maneuver ?? d.grip,
    downforce: src.downforce ?? d.downforce,
  };
  return merged;
}

/**
 * Crash penalty in turns. Static mode is a fixed number. Dynamic mode is a power
 * function of move speed (the length of the displacement vector):
 * round(speed ^ exponent), clamped to [1, CRASH_PENALTY_MAX]. At exponent 1 this
 * is linear (speed 1 -> 1 turn, 2 -> 2, 3 -> 3); higher exponents punish fast
 * crashes more steeply.
 */
export function crashPenalty(rules: Rules, speed: number): number {
  if (rules.penalty === 'static') return rules.staticTurns;
  const t = speed ** rules.dynamicExponent;
  return Math.min(CRASH_PENALTY_MAX, Math.max(1, Math.round(t)));
}

export interface GameState {
  track: Track;
  players: Player[];
  /** Race rules (off-track penalty, turn ordering). */
  rules: Rules;
  current: number;
  /**
   * Running counter of turn slots (0-based), used to keep turn order fair. A lap
   * is n slots; each lap the starting player shifts by 1 so nobody keeps the
   * advantage of going first. The player for a given slot is resolved by
   * playerForTurn(); current is kept in sync for the rest of the code that reads
   * it as "the index of whoever is moving now".
   */
  turn: number;
  phase: 'race' | 'over';
  /**
   * Race winner (1st place). Determined when the first round with a finisher gets
   * resolved, and never changes after that. `'draw'` means multiple cars tied for
   * 1st place at the same overshoot depth. The race keeps going for everyone else
   * in that case (see phase).
   */
  winner: number | 'draw' | null;
  /**
   * How many more turns to play out in the current round. null means no round is
   * in progress (nobody has crossed the finish yet). As soon as someone crosses
   * the finish, the rest of the cars on that lap get this many turns to finish
   * theirs; once it hits zero the round is resolved (resolveRound) and finishers
   * from that round get places assigned by overshoot depth. Unlike the old logic,
   * the race doesn't end here — remaining cars keep racing over subsequent laps
   * until everyone has either finished or retired.
   */
  finalTurnsLeft: number | null;
  /**
   * Seats that crossed the finish in the current, not-yet-resolved round and are
   * waiting to have places assigned. Cleared out in resolveRound.
   */
  roundFinishers: number[];
  /**
   * Turn order for the starting grid: startGridOrder[p] is the seat standing at
   * grid position p, front to back (p=0 is pole). The first lap is played in this
   * exact order (pole goes before the second row, like a real race); after that,
   * the starting player still shifts each lap as before (see playerForTurn in
   * turns.ts). This is the INVERSE permutation of startOrder from newGame (seat i
   * stands at grid position startOrder[i]); identity when there's no shuffling at
   * the start. Travels in the serialized state (so it's deterministic across all
   * clients); old snapshots without this field come back up as the identity
   * permutation (see deserializeState).
   */
  startGridOrder: number[];
}

/** Car colors and names by player index (up to six participants). */
// Brightened palette for the dark "blueprint" track surface — same hues (and name
// order, see NAMES), just punched up so they read clearly against the blue background.
const COLORS = ['#ff5d5d', '#5db4ff', '#4fd58a', '#ffa94d', '#c58cff', '#2fd4c8'];

/** Car names by color — strictly in the same order as COLORS. */
const NAMES = strings.players.names;

export const MAX_PLAYERS = COLORS.length;
// Minimum number of participants (see MIN_PLAYERS in config) — re-exported.
export { MIN_PLAYERS };

/** Car color by seat index — used to render the lobby roster in online play. */
export function seatColor(i: number): string {
  return COLORS[i % COLORS.length];
}

export interface Candidate {
  target: Vec;
  crash: boolean;
  /** Target cell is occupied by another car — this move isn't allowed. */
  blocked: boolean;
  /** The pure-inertia candidate (zero acceleration). */
  inertial: boolean;
}

/**
 * Random permutation of indices [0..n) (Fisher-Yates). rng is injectable (same as
 * in the bot's chooseMove) and defaults to Math.random. Used to randomly assign
 * starting slots to cars: in online play this only ever runs on the host and
 * travels along in the serialized state, so there's no need for every client to
 * seed it the same way.
 */
export function shuffledIndices(n: number, rng: () => number = Math.random): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function newGame(
  track: Track,
  playerCount = 2,
  rules: Rules = DEFAULT_RULES,
  // Permutation of starting slots: car i is placed at startPoints[startOrder[i]].
  // Defaults to the identity permutation (pole goes to seat 0), keeping tests and
  // fixtures deterministic.
  startOrder?: number[],
): GameState {
  const n = Math.max(
    MIN_PLAYERS,
    Math.min(MAX_PLAYERS, playerCount, track.startPoints.length),
  );
  const mk = (i: number): Player => ({
    name: NAMES[i],
    color: COLORS[i],
    pos: { ...track.startPoints[startOrder?.[i] ?? i] },
    vel: { x: 0, y: 0 },
    trail: [],
    crashes: [],
    skipTurns: 0,
    crossings: 0,
    finishOvershoot: null,
    place: null,
    retired: false,
  });
  // Grid turn order is the inverse permutation of startOrder: seat i stands at
  // position eff[i], so the seat standing at position p (front to back) is
  // eff.indexOf(p). Without shuffling, eff is the identity, so startGridOrder is too.
  const eff = Array.from({ length: n }, (_, i) => startOrder?.[i] ?? i);
  const startGridOrder = Array.from({ length: n }, (_, p) => eff.indexOf(p));
  return {
    track,
    players: Array.from({ length: n }, (_, i) => mk(i)),
    rules,
    current: startGridOrder[0], // pole position moves first (turn 0)
    turn: 0,
    phase: 'race',
    winner: null,
    finalTurnsLeft: null,
    roundFinishers: [],
    startGridOrder,
  };
}

/**
 * Deep-copy the state for confirm-first move submission: apply the move to the
 * copy, send it to the server, and only make it current on success — the original
 * stays intact so the player's choice isn't lost if the request fails. Everything
 * except track (an immutable track shared by reference) is plain JSON data, so
 * structuredClone is safe to use here.
 */
export function cloneState(g: GameState): GameState {
  const { track, ...rest } = g;
  return { ...structuredClone(rest), track };
}

/** How far past the road edge a point has strayed: 0 on the road, otherwise distance to the nearest wall. */
export function offRoadDepth(track: Track, p: Vec): number {
  if (onRoad(p, track.outer, track.inner)) return 0;
  return Math.min(
    distPointToPolyline(p, track.outer),
    distPointToPolyline(p, track.inner),
  );
}

/** Result of scanning a move segment: whether it crashed, and exactly where. */
interface MoveScan {
  crash: boolean;
  /** Parameter along from->to at the crash point (Infinity if there's no crash). */
  tCrash: number;
  /** Crash point on the tolerance boundary (null if there's no crash). */
  crashAt: Vec | null;
}

/**
 * A single pass over the move segment that both detects a crash and locates it,
 * using one criterion: depth past the edge > OFFROAD_FORGIVE. A move counts as a
 * crash if anywhere along the segment it goes past the wall deeper than the
 * tolerance: dense sampling catches both moves that punch straight through the
 * grass and deep corner-cuts, while still forgiving grazing touches.
 *
 * We find the crash point by bisecting on the tolerance isoline (depth ==
 * OFFROAD_FORGIVE) rather than on the wall itself: if the move already starts
 * inside the tolerance band past the wall and goes deeper on the same side, the
 * segment may never actually cross the wall — so looking for a "wall intersection"
 * wouldn't make sense there, whereas the tolerance threshold is always bracketed
 * (from is inside the tolerance by invariant, and the first "bad" sample is past
 * it). This way crashAt lands roughly on the boundary consistently, whether the
 * move started inside the track or already within the tolerance band — that
 * consistency is exactly what the old logic lacked.
 *
 * The "from is within tolerance" invariant: the start is a road node (see
 * track.ts), a normal move ends where scanMove found no crash (end depth <=
 * tolerance), a crashed move ends at crashAt (also within tolerance), and a
 * post-penalty return ends on a road node (nearestFreeInsidePoint).
 */
function scanMove(track: Track, from: Vec, to: Vec): MoveScan {
  const steps = Math.max(2, Math.ceil(dist(from, to) / CRASH_SAMPLE_STEP));
  let loT = 0; // last parameter value where the point was within tolerance
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (offRoadDepth(track, lerp(from, to, t)) > OFFROAD_FORGIVE) {
      // The tolerance boundary lies in (loT, t] — refine it with bisection.
      let lo = loT;
      let hi = t;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        if (offRoadDepth(track, lerp(from, to, mid)) > OFFROAD_FORGIVE) hi = mid;
        else lo = mid;
      }
      return { crash: true, tCrash: hi, crashAt: lerp(from, to, hi) };
    }
    loT = t;
  }
  return { crash: false, tCrash: Infinity, crashAt: null };
}

/** Outcome of a single car's move — plain data to apply, no player mutation. */
export interface MoveOutcome {
  /** Where the car ends up: crashAt on a crash, otherwise the target cell. */
  end: Vec;
  /** New velocity (zero on a crash). */
  vel: Vec;
  crash: boolean;
  crashAt: Vec | null;
  /** Penalty in turns on a crash, otherwise 0. */
  skipTurns: number;
  /** Change to the finish-crossing counter: -1 / 0 / +1. */
  crossingDelta: number;
  trailSeg: TrailSeg;
}

/**
 * Compute the outcome of a car's move from point from to cell target — the crash
 * and its location, finish crossing, new velocity/trail. A pure function that
 * mutates nothing; applyOutcome applies the result.
 */
/**
 * Sign of the finish crossing for segment from->to: +1 (forward), -1 (backward),
 * or 0. A point exactly on the line counts as the "ahead" side (sideOfFinish >= 0)
 * so the same crossing never gets counted twice. tCrashCutoff excludes crossings
 * that happen after a crash (for a clean move; a crash's return teleport has no
 * cutoff — Infinity).
 */
function finishCrossingDelta(
  track: Track,
  from: Vec,
  to: Vec,
  tCrashCutoff = Infinity,
): number {
  const fin = segSegIntersection(from, to, track.finish.a, track.finish.b);
  if (!fin || fin.t >= tCrashCutoff) return 0;
  const sFrom = sideOfFinish(track, from);
  const sTo = sideOfFinish(track, to);
  if (sFrom < 0 && sTo >= 0) return 1;
  if (sFrom >= 0 && sTo < 0) return -1;
  return 0;
}

export function computeOutcome(
  track: Track,
  rules: Rules,
  from: Vec,
  target: Vec,
): MoveOutcome {
  const to = { ...target };
  const { tCrash, crashAt } = scanMove(track, from, to);

  // A finish-line crossing only counts if it happened before the crash
  // (tCrash excludes crossings that occur after the point of impact).
  const crossingDelta = finishCrossingDelta(track, from, to, tCrash);

  if (crashAt) {
    return {
      end: { ...crashAt },
      vel: { x: 0, y: 0 },
      crash: true,
      crashAt: { ...crashAt },
      // Crash speed is the length of the planned move (|vel+accel|): the faster
      // you were going, the deeper into the gravel and the longer it takes to get back.
      skipTurns: crashPenalty(rules, dist(from, to)),
      crossingDelta,
      trailSeg: { from: { ...from }, to: { ...crashAt }, jump: false },
    };
  }
  return {
    end: { ...to },
    vel: { x: to.x - from.x, y: to.y - from.y },
    crash: false,
    crashAt: null,
    skipTurns: 0,
    crossingDelta,
    trailSeg: { from: { ...from }, to: { ...to }, jump: false },
  };
}

/**
 * Apply a computed outcome to a car: update the finish counter, trail, crash list,
 * position/velocity/penalty, and (once the win condition is reached) overshoot
 * depth. Advancing the turn order and determining the winner are the caller's
 * responsibility (see turns.ts).
 */
export function applyOutcome(track: Track, p: Player, o: MoveOutcome): void {
  p.crossings += o.crossingDelta;
  p.trail.push(o.trailSeg);
  if (o.crashAt) {
    // The car stays at the crash point while serving its penalty — it only gets
    // returned to the track (returnFromPenalty) once the penalty is served,
    // otherwise it would be in everyone else's way.
    p.crashes.push({ ...o.crashAt });
  }
  p.pos = { ...o.end };
  p.vel = { ...o.vel };
  p.skipTurns = o.skipTurns;
  if (p.crossings >= WIN_CROSSINGS && p.finishOvershoot === null) {
    p.finishOvershoot = sideOfFinish(track, o.end);
  }
}

/**
 * Whether a car has finished the race and no longer takes turns: it either has a
 * place already OR has already crossed the finish the required number of times
 * (finishOvershoot is set right at the crossing, while place is assigned later,
 * in resolveRound, once the round plays out). During that window place is still
 * null, but the car must not move or plan a move anymore — so this check needs
 * to cover both cases, not just place. NB: during that same window the car is
 * still physically on the track and still blocks others (see otherPositions) —
 * this function is only about whether it gets to take a turn.
 */
export function isFinished(p: Player): boolean {
  return p.place !== null || p.finishOvershoot !== null;
}

/**
 * Positions of every player except the given seat and anyone who can't block a
 * path: cars still serving a crash penalty (not yet back on the track), and cars
 * out of the race — either already assigned a place (round resolved) or retired.
 * Cars that crossed the finish but are still waiting for places to be assigned
 * (place === null) still stand on the track and block, same as any active car.
 */
export function otherPositions(state: GameState, exclude: number): Vec[] {
  return state.players
    .filter(
      (pl, i) => i !== exclude && pl.skipTurns === 0 && pl.place === null && !pl.retired,
    )
    .map((pl) => ({ ...pl.pos }));
}

/** Nearest free (unoccupied by another car) track cell to point q. */
export function nearestFreeInsidePoint(state: GameState, q: Vec, exclude: number): Vec {
  const occupied = new Set(otherPositions(state, exclude).map((o) => key(o.x, o.y)));
  let best: Vec | null = null;
  let bestD = Infinity;
  state.track.inside.forEach((k) => {
    if (occupied.has(k)) return;
    const p = unkey(k);
    const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    const better =
      d < bestD - 1e-9 ||
      (Math.abs(d - bestD) <= 1e-9 &&
        best !== null &&
        (p.y < best.y || (p.y === best.y && p.x < best.x)));
    if (better || best === null) {
      best = p;
      bestD = d;
    }
  });
  return best!;
}

/**
 * Penalty served — return the car to the nearest free track cell with a dashed
 * "teleport" out of the gravel (see afterAction in turns.ts).
 */
export function returnFromPenalty(state: GameState, seat: number): void {
  const p = state.players[seat];
  const { track } = state;
  const resetTo = nearestFreeInsidePoint(state, p.pos, seat);
  // The return teleport can carry the car across the finish line — count that
  // crossing, or a lap "completed" right up to the crash would get lost. The side
  // change is computed the same way as in computeOutcome (afterAction then picks
  // up the finish).
  p.crossings += finishCrossingDelta(track, p.pos, resetTo);
  if (p.crossings >= WIN_CROSSINGS && p.finishOvershoot === null) {
    p.finishOvershoot = sideOfFinish(track, resetTo);
  }
  p.trail.push({ from: { ...p.pos }, to: { ...resetTo }, jump: true });
  p.pos = resetTo;
}

/**
 * Resolve the current round: assign places to cars that crossed the finish in it
 * (state.roundFinishers), ranked by overshoot depth (finishOvershoot) — whoever
 * went farther past the line gets the better place. Uses "1224" sports scoring:
 * ties get the same place, and whoever comes right after a tied pair gets a
 * shifted place (two seconds are followed by a fourth). The race winner (place 1)
 * is locked in on the first resolved round that has any finishers; if 1st place
 * is tied, winner becomes `'draw'`. Once every car has a place or has retired,
 * the race is over.
 */
export function resolveRound(state: GameState): void {
  const ranked = [...state.roundFinishers].sort(
    (a, b) =>
      (state.players[b].finishOvershoot ?? -Infinity) -
      (state.players[a].finishOvershoot ?? -Infinity),
  );
  const already = state.players.filter((p) => p.place !== null).length;
  let place = already + 1;
  ranked.forEach((seat, i) => {
    if (i > 0) {
      const prev = state.players[ranked[i - 1]].finishOvershoot ?? 0;
      const cur = state.players[seat].finishOvershoot ?? 0;
      if (Math.abs(cur - prev) > 1e-9) place = already + i + 1;
    }
    state.players[seat].place = place;
  });

  if (state.winner === null && ranked.length > 0) {
    const firstPlace = state.players[ranked[0]].place;
    const firsts = ranked.filter((s) => state.players[s].place === firstPlace);
    state.winner = firsts.length > 1 ? 'draw' : firsts[0];
  }

  state.roundFinishers = [];
  state.finalTurnsLeft = null;
  if (state.players.every((p) => p.place !== null || p.retired)) {
    state.phase = 'over';
  }
}
