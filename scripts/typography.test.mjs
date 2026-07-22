import { describe, it, expect } from 'vitest';
import { typography, transform, LOCALE_RULES } from './typography.mjs';

const NBSP = '\\u00A0'; // literal escape that the tool inserts

describe('typography() — Russian (default)', () => {
  it('glues short prepositions/conjunctions (1-2 letters) to the following word', () => {
    expect(typography('я и ты')).toBe(`я${NBSP}и${NBSP}ты`);
    expect(typography('в дом')).toBe(`в${NBSP}дом`);
  });

  it('leaves words longer than 2 letters alone', () => {
    expect(typography('что делать')).toBe('что делать');
  });

  it('inserts a non-breaking space before a dash, but not after', () => {
    expect(typography('слово — слово')).toBe(`слово${NBSP}— слово`);
  });

  it('does not break a number and the following word/unit', () => {
    expect(typography('30 сек')).toBe(`30${NBSP}сек`);
    expect(typography('на 1 клетку')).toBe(`на${NBSP}1${NBSP}клетку`);
  });

  it('is idempotent (running twice == running once)', () => {
    const samples = ['я и ты', 'слово — слово', 'на 1 клетку', 'в 5 мин от дома'];
    for (const s of samples) {
      const once = typography(s);
      expect(typography(once)).toBe(once);
    }
  });
});

describe('typography() — Belarusian', () => {
  it('glues short Belarusian words, including «і» and «ў»', () => {
    expect(typography('людзей і ботаў', LOCALE_RULES.be)).toBe(`людзей і${NBSP}ботаў`);
    expect(typography('у гонцы', LOCALE_RULES.be)).toBe(`у${NBSP}гонцы`);
    // «і» isn't caught by the Russian character class — checking that the extension works.
    expect(typography('і потым', LOCALE_RULES.be)).toBe(`і${NBSP}потым`);
  });
});

describe('typography() — English', () => {
  it('does NOT glue short prepositions, but keeps "number+unit" and the dash together', () => {
    expect(typography('a to b', LOCALE_RULES.en)).toBe('a to b'); // no word gluing
    expect(typography('30 sec', LOCALE_RULES.en)).toBe(`30${NBSP}sec`);
    expect(typography('lost — reconnecting', LOCALE_RULES.en)).toBe(
      `lost${NBSP}— reconnecting`,
    );
  });
});

describe('transform() over locale source', () => {
  it('preserves ${…} substitutions in template literals', () => {
    const src = 'export const x = { online: { roster: (n) => `Игроки: ${n} из 6` } };';
    const { output } = transform(src);
    expect(output).toContain('${n}'); // placeholder untouched
    expect(output).toContain(`из${NBSP}6`); // "из 6" glued in the tail
  });

  it('handles wizard step bodies (the prefix is no longer parsed with a regex)', () => {
    const src =
      'export const x = {' +
      "  editor: { step: { finish: 'Нажми, где будет старт — это же линия финиша.' } }," +
      '};';
    const { output, changedKeys } = transform(src);
    expect(output).toContain(`старт${NBSP}—`); // the step body is now processed too
    expect(changedKeys).toContain('editor.step.finish');
  });
});
