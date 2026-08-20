import { describe, it, expect } from 'vitest';
import { DEFAULT_RULES, Rules } from '../../model/game';
import { CRASH_EXPONENT_STRICT, DRIVE_PRESETS } from '../../config';
import { strings } from '../../i18n';
import { describeSetupChanges, driveModeLabel, driveModeOf } from './rules-summary';
import type { BotFill, SetupSummary } from './rules-summary';

const NO_BOTS: BotFill = { count: 0, difficulty: 'medium' };

const setup = (rules: Partial<Rules> = {}, bots: BotFill = NO_BOTS): SetupSummary => ({
  rules: { ...DEFAULT_RULES, drive: { ...DEFAULT_RULES.drive }, ...rules },
  bots,
});

describe('driveModeOf', () => {
  it('names the preset a drive set matches', () => {
    expect(driveModeOf({ ...DRIVE_PRESETS.gt })).toBe('gt');
    expect(driveModeOf({ ...DRIVE_PRESETS.classic })).toBe('classic');
  });

  it('falls back to custom when a single axis is off a preset', () => {
    expect(driveModeOf({ ...DRIVE_PRESETS.f1, grip: DRIVE_PRESETS.f1.grip + 1 })).toBe(
      'custom',
    );
  });

  it('labels it with the same word the settings screen uses', () => {
    expect(driveModeLabel({ ...DRIVE_PRESETS.gt })).toBe(strings.settings.driveModeGt);
  });
});

describe('describeSetupChanges', () => {
  it('says nothing when the setup is the same', () => {
    expect(describeSetupChanges(setup(), setup())).toEqual([]);
  });

  it('reports a changed race length in laps, not in crossings', () => {
    const changes = describeSetupChanges(
      setup({ winCrossings: 2 }),
      setup({ winCrossings: 4 }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].label).toBe(strings.settings.lapsLabel);
    expect(changes[0].value).toBe(strings.settings.lapsOption(3));
  });

  it('reports the new handling preset by name', () => {
    const changes = describeSetupChanges(
      setup({ drive: { ...DRIVE_PRESETS.sports } }),
      setup({ drive: { ...DRIVE_PRESETS.f1 } }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].label).toBe(strings.settings.tabDrive);
    expect(changes[0].value).toBe(strings.settings.driveModeF1);
  });

  it('reports a custom drive whose numbers moved, though the mode name did not', () => {
    const before = { ...DRIVE_PRESETS.f1, grip: DRIVE_PRESETS.f1.grip + 1 };
    const changes = describeSetupChanges(
      setup({ drive: before }),
      setup({ drive: { ...before, accel: before.accel + 1 } }),
    );
    expect(changes.map((c) => c.label)).toEqual([strings.settings.tabDrive]);
  });

  it('reports the penalty kind and what qualifies it', () => {
    const changes = describeSetupChanges(
      setup({ penalty: 'dynamic' }),
      setup({ penalty: 'static', staticTurns: 3 }),
    );
    expect(changes[0].label).toBe(strings.settings.penaltyLabel);
    expect(changes[0].value).toContain(strings.settings.static);
    expect(changes[0].value).toContain('3');
  });

  it('notices a severity change within the same penalty kind', () => {
    const changes = describeSetupChanges(
      setup({ penalty: 'dynamic', dynamicExponent: 1 }),
      setup({ penalty: 'dynamic', dynamicExponent: CRASH_EXPONENT_STRICT }),
    );
    expect(changes[0].value).toContain(strings.settings.exponentStrict);
  });

  it('ignores the fixed penalty size while the penalty is speed-based', () => {
    expect(
      describeSetupChanges(
        setup({ penalty: 'dynamic', staticTurns: 2 }),
        setup({ penalty: 'dynamic', staticTurns: 5 }),
      ),
    ).toEqual([]);
  });

  it('reports the turn limit with the label the control offers', () => {
    const changes = describeSetupChanges(
      setup({ turnLimitMs: 60_000 }),
      setup({ turnLimitMs: 120_000 }),
    );
    expect(changes[0].label).toBe(strings.settings.turnLimitLabel);
    expect(changes[0].value).toBe(strings.settings.limit2m);
  });

  it('reports bots by count and difficulty', () => {
    const changes = describeSetupChanges(
      setup({}, { count: 0, difficulty: 'medium' }),
      setup({}, { count: 2, difficulty: 'hard' }),
    );
    expect(changes[0].label).toBe(strings.players.botsLabel);
    expect(changes[0].value).toContain('2');
    expect(changes[0].value).toContain(strings.aiSelect.hard);
  });

  it('stays quiet about a difficulty change while no bot is racing', () => {
    expect(
      describeSetupChanges(
        setup({}, { count: 0, difficulty: 'easy' }),
        setup({}, { count: 0, difficulty: 'hard' }),
      ),
    ).toEqual([]);
  });

  it('lists several changes in the order the settings screen shows them', () => {
    const changes = describeSetupChanges(
      setup({ drive: { ...DRIVE_PRESETS.sports }, turnLimitMs: 60_000 }),
      setup(
        { drive: { ...DRIVE_PRESETS.gt }, turnLimitMs: 30_000 },
        {
          count: 1,
          difficulty: 'medium',
        },
      ),
    );
    expect(changes.map((c) => c.label)).toEqual([
      strings.settings.tabDrive,
      strings.settings.turnLimitLabel,
      strings.players.botsLabel,
    ]);
  });
});
