// Turn ordering: players move in a round-robin (the starting player shifts every
// lap). Candidate generation with blocking of occupied cells, applying one car's
// move, advancing the turn and serving out penalties, and coasting by inertia
// (for online play). Shared outcome/winner/penalty-return logic lives in game.ts.

import { Vec, pointOnSegment } from '../geometry';
import { MIN_LAUNCH, DOWNFORCE_VREF } from '../config';
import {
  GameState,
  Candidate,
  BlockReason,
  Drive,
  WIN_CROSSINGS,
  computeOutcome,
  applyOutcome,
  otherPositions,
  returnFromPenalty,
  resolveRound,
} from './game';

/**
 * Reachable move targets from state (pos, vel) under handling `drive` — a single
 * parameterized model shared by every mode (classic is just its isotropic preset).
 * Called both by the engine (candidates) and the bot planner (ai/planner), so the
 * bot always sees exactly the same moves available to a human player.
 *
 * Around the coast point C = pos + vel sits a "traction ellipse" in the velocity
 * frame: integer grid nodes whose velocity change a = target - C fits inside an
 * ellipse with semi-axes given by drive (cells per move):
 *  - forward along the direction of travel (a.u >= 0) uses the accel semi-axis;
 *    backward (braking) uses brake_eff;
 *  - lateral (sideways) uses grip_eff;
 *  - the ellipse condition (a_along/cap)^2 + (a_lat/grip_eff)^2 <= 1 couples
 *    acceleration and steering: floor the throttle and there's no steering left,
 *    and vice versa (rounded corners).
 * Speed factors in automatically: turning by angle theta needs lateral
 * delta-v ~= |vel|*theta, so theta_max ~= grip_eff/|vel| — the faster you go, the
 * less you can turn per move (minimum radius scales as v^2/grip_eff). The coast
 * point itself (a = 0) is always in the set (0 <= 1), so inertia/coasting works
 * exactly as it does in classic mode.
 *
 * Aerodynamics: brake_eff = brake*aero, grip_eff = grip*aero, where
 * aero = aeroFactor(downforce, speed) grows with the square of speed. Downforce
 * never touches acceleration (accel). At the start (vel = 0) there's no downforce
 * and aero doesn't come into play.
 *
 * At the start (vel = 0) there's no direction yet: an isotropic disk of radius
 * max(accel, MIN_LAUNCH). The floor MIN_LAUNCH = sqrt(2) guarantees a diagonal
 * launch (the 3x3 set) regardless of accel. When all three semi-axes are equal
 * and downforce = 0, you get an isotropic circle: grip in [sqrt(2), 2) yields
 * exactly the 3x3 square (classic mode).
 */
export function reachableTargets(pos: Vec, vel: Vec, drive: Drive): Vec[] {
  const { accel, brake, grip, downforce } = drive;
  const cx = pos.x + vel.x;
  const cy = pos.y + vel.y;
  const speed = Math.hypot(vel.x, vel.y);
  // Downforce grows with speed and widens braking/grip (see aeroFactor).
  const aero = aeroFactor(downforce, speed);
  const brakeEff = brake * aero;
  const gripEff = grip * aero;
  // The search bounding box uses the EFFECTIVE semi-axes: at speed, downforce can
  // push brake/grip above their base values, so bounding by the raw values would
  // clip off otherwise-reachable nodes.
  const r = Math.ceil(Math.max(accel, brakeEff, gripEff, MIN_LAUNCH));
  const EPS = 1e-9;
  const out: Vec[] = [];
  for (let ay = -r; ay <= r; ay++) {
    for (let ax = -r; ax <= r; ax++) {
      if (speed === 0) {
        const rad = Math.max(accel, MIN_LAUNCH); // at the start, the diagonal is available to everyone
        if (ax * ax + ay * ay > rad * rad + EPS) continue;
      } else {
        const ux = vel.x / speed;
        const uy = vel.y / speed;
        const along = ax * ux + ay * uy; // longitudinal component of a (along velocity)
        const lat = -ax * uy + ay * ux; // lateral component of a (sideways)
        const cap = along >= 0 ? accel : brakeEff; // forward uses accel, backward uses braking
        const nl = cap === 0 ? (along === 0 ? 0 : Infinity) : along / cap;
        const nt = gripEff === 0 ? (lat === 0 ? 0 : Infinity) : lat / gripEff;
        if (nl * nl + nt * nt > 1 + EPS) continue; // outside the traction ellipse
      }
      out.push({ x: cx + ax, y: cy + ay });
    }
  }
  return out;
}

/**
 * Aerodynamic downforce: the factor by which lateral grip and braking grow with
 * the square of speed. aero = 1 + downforce*(speed/DOWNFORCE_VREF)^2.
 * downforce = 0 -> aero = 1 (pure mechanical grip, constant). Shared between the
 * engine (reachableTargets) and the ellipse rendering, so the visualized region
 * and the actual reachable region always match.
 */
export function aeroFactor(downforce: number, speed: number): number {
  return 1 + downforce * (speed / DOWNFORCE_VREF) ** 2;
}

/**
 * Candidate moves for an arbitrary seat, from its current pos/vel. Factored out
 * of candidates() so the move fan can be computed for a seat other than the one
 * currently moving: online play / vs-bot lets a player preview their fan before
 * their turn actually comes up (a "plan-ahead" preview).
 */
export function candidatesForSeat(state: GameState, seat: number): Candidate[] {
  const p = state.players[seat];
  const occupied = otherPositions(state, seat);
  const cx = p.pos.x + p.vel.x; // coast point C (pure inertia, a = 0)
  const cy = p.pos.y + p.vel.y;
  const targets = reachableTargets(p.pos, p.vel, state.rules.drive);
  return targets.map((target) => {
    // A move is blocked if an opponent occupies the target cell, or if the move
    // segment passes through a cell an opponent currently occupies (no driving
    // "through" another car). The two reasons are kept apart so the renderer can
    // stay quiet about the self-evident one (a car is already drawn there).
    const onTarget = occupied.some((o) => o.x === target.x && o.y === target.y);
    const blockReason: BlockReason | null = onTarget
      ? 'occupied'
      : occupied.some((o) => pointOnSegment(o, p.pos, target))
        ? 'path'
        : null;
    return {
      target,
      blockReason,
      blocked: blockReason !== null,
      crash: computeOutcome(state.track, state.rules, p.pos, target).crash,
      inertial: target.x === cx && target.y === cy,
    };
  });
}

export function candidates(state: GameState): Candidate[] {
  return candidatesForSeat(state, state.current);
}

export function applyMove(state: GameState, cand: Candidate): void {
  if (state.phase !== 'race' || cand.blocked) return;
  const p = state.players[state.current];
  const outcome = computeOutcome(state.track, state.rules, p.pos, cand.target);
  applyOutcome(state.track, p, outcome);
  afterAction(state);
}

/**
 * Player index for a running turn slot. A lap is n slots; position within the lap
 * (pos) is turn % n, lap number (round) is floor(turn / n). The starting position
 * shifts by round: rot = (round + pos) % n (so nobody keeps a first-move
 * advantage). `order` is the "grid position -> seat" permutation (startGridOrder):
 * the first lap runs in grid order front to back (order[0] is pole), and after
 * that the usual shift applies; without order (or with the identity permutation)
 * this reduces to the plain rot behavior. For n=3 with identity order: lap 1 is
 * 0,1,2; lap 2 is 1,2,0; lap 3 is 2,0,1. This is a permutation of all players on
 * every lap (nobody skipped, nobody moves twice) and is deterministic: the same
 * turn/order inputs give the same index on every client.
 */
export function playerForTurn(turn: number, n: number, order?: number[]): number {
  const round = Math.floor(turn / n);
  const pos = turn % n;
  const rot = (round + pos) % n;
  return order ? order[rot] : rot;
}

/** A slot in the turn queue: who moves and in which lap it happens. */
export interface UpcomingSlot {
  /** Player index (seat) that moves in this slot. */
  seat: number;
  /** Lap number of the slot (floor(turn / n)) — used to group the queue by lap in the UI. */
  round: number;
}

/**
 * Queue of upcoming turns with slots (seat + lap number), starting from the
 * current one (the first element is state.current). count is how many turns to
 * return. Accounts for penalty skips (a car sitting in the gravel doesn't show up
 * in the queue until its penalty is served) and for the decisive lap's remaining
 * turns (finalTurnsLeft caps how many slots are left) — exactly as afterAction
 * does. The forecast is deterministic and correct under the assumption that no
 * new crashes happen: every slot advances turn by 1, and a car serving a penalty
 * "burns" its slot without taking a turn. Past turns aren't reconstructed (there's
 * no turn log) — the queue only looks forward.
 */
export function upcomingSlots(state: GameState, count: number): UpcomingSlot[] {
  const n = state.players.length;
  const skips = state.players.map((p) => p.skipTurns);
  const out: UpcomingSlot[] = [];
  let turn = state.turn;
  let slotsLeft = state.finalTurnsLeft; // null means no round is in progress, no slot limit
  while (out.length < count && (slotsLeft === null || slotsLeft > 0)) {
    const seat = playerForTurn(turn, n, state.startGridOrder);
    const p = state.players[seat];
    if (p.place !== null || p.retired) {
      // Out of the race (has a place / retired) — doesn't take a turn, slot burns.
    } else if (skips[seat] > 0) {
      skips[seat] -= 1; // slot burns while serving the penalty
    } else {
      out.push({ seat, round: Math.floor(turn / n) });
    }
    turn += 1;
    if (slotsLeft !== null) slotsLeft -= 1;
  }
  return out;
}

/** Player indices for upcoming turns (without lap numbers) — see upcomingSlots. */
export function upcomingTurns(state: GameState, count: number): number[] {
  return upcomingSlots(state, count).map((s) => s.seat);
}

/**
 * Advance the turn and account for finishing. Players move round-robin; the
 * order within a lap is set by playerForTurn (the starting player shifts each
 * lap). As soon as someone crosses the finish, a "round" opens: the rest of the
 * cars on that same lap (those after the current seat) get to finish out their
 * turns — cars that already moved earlier in the lap already had their chance.
 * Once the round runs out, resolveRound assigns places to that round's finishers
 * by overshoot depth. Unlike the old logic, the race doesn't end here — remaining
 * cars keep racing over subsequent laps until everyone has finished or retired
 * (at which point resolveRound/retireCurrent sets phase='over'). Cars that are
 * out of the race (place assigned or retired) are skipped automatically in the
 * queue — their slot burns without a turn, same as a post-crash penalty skip.
 */
function afterAction(state: GameState): void {
  if (state.phase !== 'race') return;
  const n = state.players.length;
  const seat = state.turn % n; // position of the mover within the current lap
  const cur = state.players[state.current];

  // The car just crossed the finish the required number of times and isn't in
  // this round yet — count it toward the current round.
  const finished =
    cur.crossings >= WIN_CROSSINGS &&
    cur.place === null &&
    !state.roundFinishers.includes(state.current);
  if (finished) state.roundFinishers.push(state.current);

  if (state.finalTurnsLeft !== null) {
    // A round was already in progress before this move: it shortens the number
    // of slots left in it (the finishing move that opened the round itself
    // doesn't count as a slot — that's handled in the else branch below, where
    // finalTurnsLeft = number of cars AFTER it in the lap).
    state.finalTurnsLeft -= 1;
    if (state.finalTurnsLeft <= 0) {
      resolveRound(state); // assigns places, may set phase='over'
      if (state.phase !== 'race') return;
    }
  } else if (finished) {
    // First finish of the round: cars later in this lap than the current seat
    // get to finish their turns.
    state.finalTurnsLeft = n - 1 - seat;
    if (state.finalTurnsLeft <= 0) {
      resolveRound(state);
      if (state.phase !== 'race') return;
    }
  }

  state.turn += 1;
  state.current = playerForTurn(state.turn, n, state.startGridOrder);
  const next = state.players[state.current];
  if (next.skipTurns > 0) {
    next.skipTurns -= 1;
    // Penalty served — only now do we return the car to the track.
    if (next.skipTurns === 0) returnFromPenalty(state, state.current);
    afterAction(state);
  } else if (next.place !== null || next.retired) {
    // Out of the race — doesn't take a turn, slot burns, turn advances further.
    afterAction(state);
  }
}

/**
 * Player retirement: car `seat` drops out of the race (doesn't get a place,
 * doesn't take turns). A player can retire at any point, not just on their own
 * turn. If no active cars remain after this, the race is over. If the retiring
 * player is the current mover, the turn advances (afterAction handles the round
 * bookkeeping); if someone else retires, the queue is left alone — their slot
 * will simply be skipped when it comes up (afterAction/upcomingTurns).
 */
export function retireSeat(state: GameState, seat: number): void {
  if (state.phase !== 'race') return;
  const p = state.players[seat];
  if (p.place !== null || p.retired) return;
  p.retired = true;
  if (state.players.every((pl) => pl.place !== null || pl.retired)) {
    state.phase = 'over';
    return;
  }
  if (seat === state.current) afterAction(state);
}

/**
 * Skip the turn of an absent/stalling player: the car keeps traveling straight
 * at the same speed (pure inertia, zero acceleration). If the inertial cell is
 * occupied by another car, the car just stays put at zero speed and the turn
 * simply moves on. Crashes/finish crossings/penalties are all handled normally
 * through applyMove. Deterministic: two clients applying coastMove to the same
 * state get an identical result (safe under last-write-wins in online play).
 */
export function coastMove(state: GameState): void {
  if (state.phase !== 'race') return;
  const p = state.players[state.current];
  // The car is stationary (at the start / after a crash) — there's nowhere for
  // inertia to carry it, so just pass, without pushing a degenerate zero-length
  // trail segment on every skip.
  if (p.vel.x === 0 && p.vel.y === 0) {
    afterAction(state);
    return;
  }
  const inertial = candidates(state).find((c) => c.inertial)!;
  if (inertial.blocked) {
    p.vel = { x: 0, y: 0 };
    afterAction(state);
  } else {
    applyMove(state, inertial);
  }
}
