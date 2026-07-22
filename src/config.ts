// Numeric "knobs" for game tuning, all in one place — race rules, world size,
// track-drawing validation thresholds, and touch-interaction parameters. Every
// constant has a comment explaining what it does and how it affects gameplay.
//
// This file holds only gameplay/interaction settings. Colors and one-off visual
// values live in render.ts; purely algorithmic smoothing parameters and epsilons
// live in centerline.ts / geometry.ts.

// ── Players ──────────────────────────────────────────────
/** Minimum number of racers. */
export const MIN_PLAYERS = 2;

// ── Race rules ───────────────────────────────────────────
/**
 * How many times a car must cross the finish line to win: the 1st crossing is
 * counted right after the start (cars line up behind the line), the 2nd is a
 * full lap completed.
 */
export const WIN_CROSSINGS = 2;
/** How many turns a car sits "in the pits" for repairs after going off track.
 *  Used as the default value for the static penalty (see Rules). */
export const CRASH_SKIP_TURNS = 3;

// ── Dynamic crash penalty ────────────────────────────────
// A speed-based penalty: the faster a car goes off track, the longer it takes
// to get back out of the gravel. Turn count = a power function of the move's
// speed (the length of the displacement vector): penalty = round(speed ^
// severity), clamped to [1, MAX]. At the standard severity (1) the curve is
// linear: speed 1→1 turn, 2→2, 3→3, 4→4 (players usually brake before going
// off, so typical crash speed is fairly low). Higher severity makes the
// penalty ramp up faster for high-speed crashes.
/** Cap on the dynamic penalty, in turns — so a hard crash doesn't knock a
 *  player out of the race entirely. */
export const CRASH_PENALTY_MAX = 8;
/** Two "severity" levels (the exponent) for the dynamic penalty. Above 1.5 the
 *  penalty hits the cap almost immediately, so there's no real continuum —
 *  just these two options. */
export const CRASH_EXPONENT_STANDARD = 1; // linear: speed 1→1, 2→2, 3→3, 4→4
export const CRASH_EXPONENT_STRICT = 1.5; // steeper: 1→1, 2→3, 3→5, 4→8
/** Range and step for the static penalty size (in turns) slider in settings. */
export const STATIC_TURNS_MIN = 1;
export const STATIC_TURNS_MAX = 8;

// ── Car handling ("grip ellipse") ────────────────────────
// The drive model (see Rules and reachableTargets in turns.ts): around the
// coasting point C = pos + vel there's a "grip ellipse" in velocity space —
// the integer nodes whose velocity change a = target − C fits inside the
// ellipse. There are three "mechanical" semi-axes (cells/turn): forward
// acceleration (accel), braking (brake), and lateral grip (grip). The
// ellipse's corners are rounded, so you can't simultaneously max out
// acceleration and turn sharply (that's the grip trade-off); the faster you
// go, the less you can turn per move. If all three are equal, the ellipse is
// an isotropic circle — the classic 3×3.
//
// The fourth axis is downforce (aerodynamic load): unlike mechanical grip
// (constant), downforce grows with the square of speed and is added to grip
// and brake — grip_eff = grip·aero, brake_eff = brake·aero, where aero = 1 +
// downforce·(speed/DOWNFORCE_VREF)² (see aeroFactor in turns.ts). Acceleration
// (accel) is unaffected by downforce. This is how an F1 car (high downforce)
// takes fast corners nearly flat out, while a road car / sports car can't.
// Values are tuned by playtesting.
/** Preset handling profiles (a ladder by downforce). classic — isotropic (all
 *  axes equal, downforce 0 → a 3×3 square); sports — brakes reach twice as
 *  far as acceleration, no aero; gt — more grip plus a bit of downforce; f1 —
 *  strong downforce. Future "cars with perks" get added here too. */
export const DRIVE_PRESETS = {
  classic: { accel: 1.5, brake: 1.5, grip: 1.5, downforce: 0 },
  sports: { accel: 1, brake: 2, grip: 1.5, downforce: 0 },
  gt: { accel: 1, brake: 2, grip: 2, downforce: 0.3 },
  f1: { accel: 1, brake: 2.5, grip: 2, downforce: 0.75 },
} as const;
/** Range and step for the mechanical-axis sliders (accel/brake/grip) in
 *  "Custom" mode. Minimum is 1: a semi-axis below 1 wouldn't reach a single
 *  integer node (i.e. accel/brake/turning would be impossible), so such a
 *  value would be meaningless. */
export const DRIVE_MIN = 1;
export const DRIVE_MAX = 4;
export const DRIVE_STEP = 0.5;
/** Range and step for the downforce slider — its own scale: 0 (no aero) to
 *  1.5, step 0.25. Kept separate from the mechanical axes since it's a
 *  dimensionless coefficient for how grip grows with speed, not a semi-axis
 *  in cells. */
export const DOWNFORCE_MIN = 0;
export const DOWNFORCE_MAX = 1.5;
export const DOWNFORCE_STEP = 0.25;
/** Reference speed (cells/turn) in the downforce formula aero = 1 +
 *  downforce·(speed/DOWNFORCE_VREF)²: at this speed, downforce = 1 doubles
 *  grip. Matters for balance: because of the v² term, the minimum turning
 *  radius under downforce bottoms out at a "floor" R_floor =
 *  DOWNFORCE_VREF²/(grip·downforce) — corners gentler than that floor can be
 *  taken flat out at any speed. We keep VREF high (downforce only kicks in at
 *  genuinely high speed) so that floor stays bigger than typical track
 *  corners and braking is still required (otherwise the race loses its
 *  point). Tuned by playtesting. */
export const DOWNFORCE_VREF = 6;
/** Floor on launch radius at the start (vel = 0): guarantees a diagonal start
 *  (the 3×3 set) regardless of acceleration. A powerful accel (> √2) launches
 *  further in a straight line. */
export const MIN_LAUNCH = Math.SQRT2;
/**
 * Tolerance for straying past the track edge, in cells. A move that clips the
 * wall no deeper than this doesn't count as a crash — you can graze it. 0
 * would mean strict "exactly on the edge."
 */
export const OFFROAD_FORGIVE = 0.05;
/** Sampling step for a move segment during crash checks, in cells (smaller =
 *  more precise). */
export const CRASH_SAMPLE_STEP = 0.05;
/**
 * Minimum width of a "grass median" between two passes of the track, in
 * cells. A track with a narrower median fails validation: otherwise a move
 * through it wouldn't be caught as a crash (the depth past the edge inside a
 * thin median stays ≤ OFFROAD_FORGIVE), letting a car drive "straight
 * through" onto another loop of the track. The hard correctness floor is
 * 2·OFFROAD_FORGIVE = 0.1; we add margin for the sampling step. The generator
 * targets a gap of SELF_GAP = 1.0 ≫ this, so normal tracks always pass — this
 * threshold only catches pathological self-touching. */
export const GAP_MIN = 0.3;

// ── Online: disconnect resilience ────────────────────────
/** How long we wait for a player's turn before it can be skipped, ms. A
 *  present player is skipped manually; an absent one is skipped
 *  automatically (the first time with this grace period, instantly after). */
export const TURN_TIMEOUT_MS = 60_000;
/** How long after a player leaves presence before we remove their abandoned
 *  seat from the lobby, ms. */
export const LOBBY_PRUNE_MS = 10_000;
/** Timeout for a Supabase (REST) network request, ms: past this we treat the
 *  request as failed and release the await, so the UI never hangs on an
 *  unresolved promise. */
export const NET_TIMEOUT_MS = 10_000;
/** Delay before a silent retry of auto-skip after a failed write, ms. */
export const SKIP_RETRY_MS = 5_000;

// ── vs. Computer ─────────────────────────────────────────
/** Delay before a bot's move, ms — gives the human time to follow other
 *  players' moves. */
export const AI_MOVE_DELAY_MS = 600;

// ── World / grid ─────────────────────────────────────────
/**
 * Side length of the square "effectively infinite" field, in cells. The grid
 * is only drawn within the visible viewport (see render.ts), and framing
 * comes from the track's bbox (fit-to-track), so screen aspect ratio doesn't
 * affect world size. This is just a generous geometry safety margin and a
 * safe range for key() — the actual drawn track only occupies a few dozen
 * cells near the center of the field. */
export const WORLD_SIZE = 240;
/** Clearance from the wall: nodes closer than this to the edge don't count as
 *  part of the road. */
export const WALL_CLEARANCE = 0.15;
/** How many starting positions the track prepares — the effective max number
 *  of cars. */
export const MAX_START_POINTS = 6;
// ── Starting grid geometry (cells) ───────────────────────
// Cars are arranged in rows along the corridor behind the finish line (see
// layoutStartGrid in track.ts). A "row" is one layer of corridor depth (BFS
// steps back from the line): on a straight this is a column of nodes, on a
// curve it's an arc following the road's bend. A row fills from the track's
// centerline outward to the sides, up to START_ROW_MAX cars; any that don't
// fit spill into the next (deeper) layer. The point is to minimize depth for
// a centered start: nobody stands off to the side near the wall (a side
// start is sometimes an advantage and sometimes not — we remove that noise),
// and extra depth only appears once there are more cars than fit across the
// central lane. Which car gets which slot is decided by a random shuffle
// (newGame); with fewer players, the front slots are used (the first row on
// the line), so 2–3 cars start with no extra depth at all.
/** Max cars per row (width of the central lane). We don't go wider than this
 *  so nobody starts against the wall; extras spill into the next row. */
export const START_ROW_MAX = 3;
/** Depth of the starting zone, in BFS steps back from the finish line. The
 *  half-plane "behind the finish" on a winding track can also reach far-off
 *  segments of the track (e.g. the central loop) — if those were left as
 *  candidates, fallback filling could place a car in the middle of a lap.
 *  We restrict the zone to the connected corridor right behind the line:
 *  MAX_START_POINTS cars lined up nose-to-tail need a depth of about 6; we
 *  take some margin, but it's still far shallower than the loop distance to
 *  a far segment (dozens of cells). */
export const START_REGION_DEPTH = 8;
/** How close to the finish SEGMENT (not its infinite line) a node must lie to
 *  become a BFS seed for the starting zone. The finish line's infinite
 *  extension also crosses other segments of a winding track — anchoring to
 *  the segment itself keeps the zone from "growing" out of those. */
export const START_SEED_TOL = 1.6;
/** How many notional km/h one cell of acceleration per turn represents.
 *  A realistic race ceiling of ~7 cells maps to a Formula 1 top speed
 *  (~350 km/h), so the speedometer reading feels "race-authentic." */
export const KMH_PER_CELL = 50;

// ── Drawn-track validation ───────────────────────────────
/** Minimum road cells in the ribbon — otherwise "the track is too narrow." */
export const MIN_ROAD_CELLS = 30;
/** Minimum centerline loop area (cells²) — otherwise "too tight for a race." */
export const MIN_CENTER_AREA = 60;
/** Minimum track ribbon width, in cells. */
export const WIDTH_MIN = 2;
/** Maximum track ribbon width, in cells. */
export const WIDTH_MAX = 6;

// ── Camera / zoom ────────────────────────────────────────
/** Minimum on-screen cell size, css-px — the "zoom out" ceiling. */
export const SCALE_MIN = 8;
/** Maximum on-screen cell size, css-px — the zoom-in limit. */
export const SCALE_MAX = 64;
/** Cell size for the initial view of the empty field (before drawing), css-px. */
export const SCALE_DEFAULT = 18;
/** Fraction of free space to leave around the track on auto-fit (along the
 *  tighter axis). */
export const FIT_MARGIN = 0.08;
/** Zoom multiplier per tap of the ＋/－ button. */
export const ZOOM_BTN_FACTOR = 1.35;
/** Mouse-wheel zoom sensitivity (multiplier per wheel "click"). */
export const WHEEL_FACTOR = 1.0015;

// ── Interaction (touch/mouse) ────────────────────────────
/** How many css-px to lift the point above the finger while drawing/aiming,
 *  so the finger doesn't cover it. */
export const TOUCH_LIFT = 28;
/** Hit radius for a finger tap on a move candidate / edge point, css-px. */
export const TOUCH_TOL_PX = 24;
/** Activation radius for aiming around the nearest candidate, css-px: a touch
 *  closer than this starts aiming, farther starts panning the map. */
export const AIM_ZONE_PX = 44;
/** "Tap vs. pan" threshold, css-px: pointer movement past this turns a
 *  click-action (finish/move/arrow selection) into panning. */
export const DRAG_PX = 6;
/** Once the on-screen cell size reaches this, points are already easy to tap
 *  with a finger — the aiming loupe is no longer shown. */
export const LOUPE_MAX_CELL_PX = 26;
/** Double-tapping the field during a race zooms the camera to that point. Max
 *  window between taps, ms. */
export const DOUBLE_TAP_MS = 300;
/** Max distance between the two taps of a double-tap, css-px (otherwise
 *  they're treated as two separate taps). */
export const DOUBLE_TAP_SLOP_PX = 30;
/** How many css-px of vertical drag after a double-tap doubles/halves the
 *  zoom — sensitivity for the continuous "double-tap + drag" zoom gesture
 *  (as in map apps). */
export const DOUBLE_TAP_DRAG_PX_PER_2X = 160;
/** Height of the field's bottom zone (css-px from the bottom edge) that, if a
 *  candidate falls into it, causes the floating confirm button to move up so
 *  it doesn't cover the candidate. Covers the button itself (bottom 16 +
 *  height ~48) with margin for the point radius and the finger. While
 *  candidates stay above this zone, the button remains at the bottom. */
export const CONFIRM_BTN_ZONE_PX = 104;
