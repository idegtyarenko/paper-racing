import { describe, it, expect } from 'vitest';
import { typography, transform, LOCALE_RULES } from './typography.mjs';

const NBSP = '\\u00A0'; // литерал-эскейп, который вставляет инструмент

describe('typography() — русский (по умолчанию)', () => {
  it('приклеивает короткие предлоги/союзы (1–2 буквы) к следующему слову', () => {
    expect(typography('я и ты')).toBe(`я${NBSP}и${NBSP}ты`);
    expect(typography('в дом')).toBe(`в${NBSP}дом`);
  });

  it('не трогает слова длиннее 2 букв', () => {
    expect(typography('что делать')).toBe('что делать');
  });

  it('ставит неразрывный пробел перед тире, но не после', () => {
    expect(typography('слово — слово')).toBe(`слово${NBSP}— слово`);
  });

  it('не разрывает число и следующее слово/единицу', () => {
    expect(typography('30 сек')).toBe(`30${NBSP}сек`);
    expect(typography('на 1 клетку')).toBe(`на${NBSP}1${NBSP}клетку`);
  });

  it('идемпотентна (двойной прогон == одинарный)', () => {
    const samples = ['я и ты', 'слово — слово', 'на 1 клетку', 'в 5 мин от дома'];
    for (const s of samples) {
      const once = typography(s);
      expect(typography(once)).toBe(once);
    }
  });
});

describe('typography() — белорусский', () => {
  it('склеивает белорусские короткие слова, включая «і» и «ў»', () => {
    expect(typography('людзей і ботаў', LOCALE_RULES.be)).toBe(`людзей і${NBSP}ботаў`);
    expect(typography('у гонцы', LOCALE_RULES.be)).toBe(`у${NBSP}гонцы`);
    // «і» не ловится русским классом — проверяем, что расширение работает.
    expect(typography('і потым', LOCALE_RULES.be)).toBe(`і${NBSP}потым`);
  });
});

describe('typography() — английский', () => {
  it('НЕ склеивает короткие предлоги, но держит «число+единица» и тире', () => {
    expect(typography('a to b', LOCALE_RULES.en)).toBe('a to b'); // без склейки слов
    expect(typography('30 sec', LOCALE_RULES.en)).toBe(`30${NBSP}sec`);
    expect(typography('lost — reconnecting', LOCALE_RULES.en)).toBe(
      `lost${NBSP}— reconnecting`,
    );
  });
});

describe('transform() над исходником локали', () => {
  it('сохраняет подстановки ${…} в шаблонных литералах', () => {
    const src = 'export const x = { online: { roster: (n) => `Игроки: ${n} из 6` } };';
    const { output } = transform(src);
    expect(output).toContain('${n}'); // плейсхолдер не тронут
    expect(output).toContain(`из${NBSP}6`); // «из 6» склеено в хвосте
  });

  it('обрабатывает шаговые тела мастера (префикс больше не парсится регуляркой)', () => {
    const src =
      'export const x = {' +
      "  editor: { step: { finish: 'Нажми, где будет старт — это же линия финиша.' } }," +
      '};';
    const { output, changedKeys } = transform(src);
    expect(output).toContain(`старт${NBSP}—`); // тело шага теперь тоже обрабатывается
    expect(changedKeys).toContain('editor.step.finish');
  });
});
