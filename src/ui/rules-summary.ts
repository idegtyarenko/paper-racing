// Putting race settings into words: which handling preset a set of drive values
// is, and what changed between two setups. Pure functions over Rules — no DOM —
// so they're unit-tested (rules-summary.test.ts). They live in ui/ rather than
// model/ because they're presenters: they read the i18n strings and speak in the
// same words the settings screen uses.

import { Drive, Rules } from '../model/game';
import { Difficulty } from '../model/ai';
import { CRASH_EXPONENT_STRICT, DRIVE_PRESETS } from '../config';
import { strings } from '../i18n';

type DrivePreset = keyof typeof DRIVE_PRESETS;
export type DriveMode = DrivePreset | 'custom';

/** The bot fill as the lobby knows it (see SerializedSetup in online/net.ts). */
export interface BotFill {
  count: number;
  difficulty: Difficulty;
}

/** A setup as the guest is shown it: the rules plus the host's bot fill. */
export interface SetupSummary {
  rules: Rules;
  bots: BotFill;
}

/** One changed setting, ready to be read out: "Car handling — GT". */
export interface SettingChange {
  label: string;
  value: string;
}

/** Whether drive matches a built-in preset (all four axes equal its values). */
const isPreset = (d: Drive, p: Drive): boolean =>
  d.accel === p.accel &&
  d.brake === p.brake &&
  d.grip === p.grip &&
  d.downforce === p.downforce;

/** Handling mode derived from drive values: the preset's name if it matches
 *  one, otherwise "Custom". Iterates over DRIVE_PRESETS, so new presets are
 *  picked up automatically. */
export function driveModeOf(d: Drive): DriveMode {
  for (const [name, p] of Object.entries(DRIVE_PRESETS)) {
    if (isPreset(d, p)) return name as DrivePreset;
  }
  return 'custom';
}

/** The handling mode's name, as the settings screen labels it. */
export function driveModeLabel(d: Drive): string {
  const s = strings.settings;
  const byMode: Record<DriveMode, string> = {
    sports: s.driveModeSports,
    gt: s.driveModeGt,
    f1: s.driveModeF1,
    classic: s.driveModeClassic,
    custom: s.driveModeCustom,
  };
  return byMode[driveModeOf(d)];
}

/** The crash penalty in one phrase: its kind plus whatever qualifies it —
 *  severity for the speed-based one, the number of turns for the fixed one. */
function penaltyValue(r: Rules): string {
  const s = strings.settings;
  if (r.penalty === 'static') return `${s.static} · ${r.staticTurns}`;
  const severity =
    r.dynamicExponent === CRASH_EXPONENT_STRICT ? s.exponentStrict : s.exponentStandard;
  return `${s.dynamic} · ${severity}`;
}

/** The per-turn limit, using the same four labels the control offers; an
 *  unlisted value (an old row, a future option) falls back to whole seconds. */
function turnLimitValue(ms: number): string {
  const s = strings.settings;
  const known: Record<number, string> = {
    30000: s.limit30s,
    60000: s.limit1m,
    120000: s.limit2m,
    300000: s.limit5m,
  };
  return known[ms] ?? `${Math.round(ms / 1000)} s`;
}

/** The bot fill in one phrase: how many, and how good. */
function botsValue(bots: BotFill): string {
  if (bots.count <= 0) return '0';
  return `${bots.count} · ${strings.aiSelect[bots.difficulty]}`;
}

/**
 * What moved between two setups, in the order the settings screen lists them.
 * Empty when nothing did — the caller (the guest's lobby) stays quiet then, and
 * a row that merely echoes our own state never becomes an announcement.
 */
export function describeSetupChanges(
  before: SetupSummary,
  after: SetupSummary,
): SettingChange[] {
  const s = strings.settings;
  const out: SettingChange[] = [];
  // Race length first — it changes what the whole race is, not how a corner drives.
  if (before.rules.winCrossings !== after.rules.winCrossings) {
    out.push({ label: s.lapsLabel, value: s.lapsOption(after.rules.winCrossings - 1) });
  }
  // Compared by the values, not by the mode name: two "Custom" sets with
  // different numbers are a real change, and the guest is racing the numbers.
  if (!isPreset(before.rules.drive, after.rules.drive)) {
    out.push({ label: s.tabDrive, value: driveModeLabel(after.rules.drive) });
  }
  if (penaltyValue(before.rules) !== penaltyValue(after.rules)) {
    out.push({ label: s.penaltyLabel, value: penaltyValue(after.rules) });
  }
  if (before.rules.turnLimitMs !== after.rules.turnLimitMs) {
    out.push({ label: s.turnLimitLabel, value: turnLimitValue(after.rules.turnLimitMs) });
  }
  if (botsValue(before.bots) !== botsValue(after.bots)) {
    out.push({ label: strings.players.botsLabel, value: botsValue(after.bots) });
  }
  return out;
}
