// Сборочный инструмент типографики: расставляет неразрывные пробелы (U+00A0) в
// строковых литералах файлов локалей `src/i18n/{ru,be,en}.ts`, чтобы в вёрстке не
// оставалось висячих коротких предлогов/союзов, висячих тире и разрывов «число —
// единица».
//
// Правила — per-locale (см. LOCALE_RULES): русский и белорусский склеивают короткие
// слова (белорусский класс букв расширен на `і`/`ў`), английский коротких предлогов
// не склеивает (только «число+единица» и неразрыв перед тире).
//
// Не рантайм: правки запекаются прямо в исходник строкой-эскейпом ` `
// (видна в diff — можно отревьюить), поэтому приложение ничего не считает на лету.
// Правит ТОЛЬКО текст строковых литералов (через AST TypeScript) — код,
// комментарии и подстановки `${…}` в шаблонных литералах не трогает.
//
// Запуск:  node scripts/typography.mjs           — записать изменения в файлы локалей
//          node scripts/typography.mjs --check    — только проверить (exit 1, если
//                                                    строки требуют обработки)
// Функции `typography()`, `transform()` и `LOCALE_RULES` экспортируются для тестов.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

// Вставляем именно литерал-эскейп из 6 символов « », а не сам байт U+00A0 —
// так неразрывный пробел виден в diff и его можно отревьюить.
const NBSP = '\\u00A0';

/**
 * Правила типографики по локали:
 *  - wordClass — класс букв для правил «короткое слово» и «число+единица». Белорусский
 *    добавляет `і` (U+0456), `ў` (U+045E) и их заглавные — иначе `і` (частый союз «и»)
 *    и слова с `ў` не ловятся русским классом `[а-яё]`.
 *  - shortWords — склеивать ли предлоги/союзы 1–2 буквы со следующим словом. В
 *    английском такой традиции нет — только «число+единица» и неразрыв перед тире.
 */
export const LOCALE_RULES = {
  ru: { wordClass: 'а-яёА-ЯЁ', shortWords: true },
  be: { wordClass: 'а-яёіўА-ЯЁІЎ', shortWords: true },
  en: { wordClass: 'a-zA-Z', shortWords: false },
};

/**
 * Чистая идемпотентная типографика для текста ОДНОГО строкового литерала под правила
 * локали. Каждое правило ищет обычный пробел (U+0020); после подстановки ` `
 * повторный прогон уже ничего не находит.
 */
export function typography(text, rules = LOCALE_RULES.ru) {
  const { wordClass, shortWords } = rules;
  let out = text;
  // 1. Короткие слова (1–2 буквы: предлоги/союзы) приклеиваем к следующему слову.
  //    Lookbehind — чтобы это было начало слова (не хвост длинного) и чтобы соседние
  //    короткие слова оба склеились («я и ты»). Только для локалей со shortWords.
  if (shortWords) {
    out = out.replace(
      new RegExp(`(?<![^\\s(«„"—])([${wordClass}]{1,2}) (?=\\S)`, 'gu'),
      `$1${NBSP}`,
    );
  }
  // 2. Тире не должно начинать строку — неразрывный пробел ПЕРЕД тире (после тире
  //    пробел обычный, там перенос допустим). Универсально для всех локалей.
  out = out.replace(/ —/g, `${NBSP}—`);
  // 3. Число и следующее за ним слово/единицу не разрываем («30 сек» / «30 sec»).
  out = out.replace(new RegExp(`(\\d) (?=[${wordClass}])`, 'gu'), `$1${NBSP}`);
  return out;
}

const LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

// Точечный путь до литерала (для отчёта --check): собираем имена property-присваиваний вверх по дереву.
function keyPathOf(node, sf) {
  const parts = [];
  for (let n = node; n; n = n.parent) {
    if (ts.isPropertyAssignment(n)) parts.unshift(n.name.getText(sf));
  }
  return parts.join('.') || '(literal)';
}

// Границы ВНУТРЕННЕГО текста литерала (без кавычек/бэктиков и без `${`/`}`).
function innerRange(node, sf) {
  const start = node.getStart(sf) + 1; // после открывающей кавычки/бэктика/`}`
  let end = node.getEnd() - 1; // до закрывающей кавычки/бэктика
  // TemplateHead/Middle заканчиваются на `${` — отрезаем два символа.
  if (
    node.kind === ts.SyntaxKind.TemplateHead ||
    node.kind === ts.SyntaxKind.TemplateMiddle
  ) {
    end = node.getEnd() - 2;
  }
  return [start, end];
}

/** Обработать исходник файла локали под её правила. Возвращает { output, changedKeys }. */
export function transform(source, rules = LOCALE_RULES.ru) {
  const sf = ts.createSourceFile('locale.ts', source, ts.ScriptTarget.Latest, true);
  const edits = [];

  function visit(node) {
    if (LITERAL_KINDS.has(node.kind)) {
      const [start, end] = innerRange(node, sf);
      const inner = source.slice(start, end);
      const out = typography(inner, rules);
      if (out !== inner) edits.push({ start, end, out, key: keyPathOf(node, sf) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  // Применяем от конца к началу, чтобы смещения не съезжали.
  edits.sort((a, b) => b.start - a.start);
  let output = source;
  for (const e of edits) output = output.slice(0, e.start) + e.out + output.slice(e.end);

  const changedKeys = [...new Set(edits.map((e) => e.key))].sort();
  return { output, changedKeys };
}

/** Файлы локалей и их правила. */
const LOCALE_FILES = [
  ['ru', '../src/i18n/ru.ts'],
  ['be', '../src/i18n/be.ts'],
  ['en', '../src/i18n/en.ts'],
];

function main() {
  const check = process.argv.includes('--check');
  const dir = dirname(fileURLToPath(import.meta.url));
  let anyChanged = false;

  for (const [code, rel] of LOCALE_FILES) {
    const file = resolve(dir, rel);
    const source = readFileSync(file, 'utf8');
    const { output, changedKeys } = transform(source, LOCALE_RULES[code]);
    if (output === source) continue;
    anyChanged = true;
    if (check) {
      console.error(
        `typo:check — ${code}: строки требуют неразрывных пробелов (запусти \`npm run typo\`):`,
      );
      for (const k of changedKeys) console.error('  ' + k);
    } else {
      writeFileSync(file, output, 'utf8');
      console.log(`typo — ${code}: обработано строк: ${changedKeys.length}`);
      for (const k of changedKeys) console.log('  ' + k);
    }
  }

  if (check) {
    if (anyChanged) process.exit(1);
    console.log('typo:check — OK, все локали обработаны.');
  } else if (!anyChanged) {
    console.log('typo — изменений нет.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
