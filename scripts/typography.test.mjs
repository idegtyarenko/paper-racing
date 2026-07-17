import { describe, it, expect } from 'vitest';
import { typography, transform } from './typography.mjs';

const NBSP = '\\u00A0'; // литерал-эскейп, который вставляет инструмент

describe('typography()', () => {
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

describe('transform() над исходником strings.ts', () => {
  it('сохраняет подстановки ${…} в шаблонных литералах', () => {
    const src = 'export const x = { online: { roster: (n) => `Игроки: ${n} из 6` } };';
    const { output } = transform(src);
    expect(output).toContain('${n}'); // плейсхолдер не тронут
    expect(output).toContain(`из${NBSP}6`); // «из 6» склеено в хвосте
  });

  it('пропускает группу editor.step целиком (её парсит регулярка panel.ts)', () => {
    const src =
      'export const strings = {' +
      "  editor: { step: { finish: 'Трасса: шаг 3 из 4. Нажми, где будет старт — это же линия финиша.' } }," +
      "  track: { notClosed: 'Трасса должна быть кольцевой — замкни ее.' }," +
      '} as const;';
    const { output, changedKeys } = transform(src);
    // editor.step.finish не изменён: тире и «шаг 3 из 4» остались с обычными пробелами.
    expect(output).toContain('старт — это');
    expect(output).not.toContain(`старт${NBSP}—`);
    expect(output).not.toContain(`3${NBSP}из`);
    // track.notClosed обработан: неразрывный пробел перед тире.
    expect(output).toContain(`кольцевой${NBSP}—`);
    expect(changedKeys).toContain('track.notClosed');
    expect(changedKeys).not.toContain('editor.step.finish');
  });
});
