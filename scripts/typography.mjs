// Сборочный инструмент типографики: расставляет неразрывные пробелы (U+00A0) в
// интерфейсных строках `src/strings.ts`, чтобы в вёрстке не оставалось висячих
// коротких предлогов/союзов, висячих тире и разрывов «число — единица».
//
// Не рантайм: правки запекаются прямо в исходник строкой-эскейпом ` `
// (видна в diff — можно отревьюить), поэтому приложение ничего не считает на лету.
// Правит ТОЛЬКО текст строковых литералов (через AST TypeScript) — код,
// комментарии и подстановки `${…}` в шаблонных литералах не трогает. Группа
// `editor.step.*` пропускается целиком: её префикс «Трасса: шаг N из N.» парсит
// регулярка в `src/ui/panel.ts`, и nbsp внутри неё сломал бы разбор.
//
// Запуск:  node scripts/typography.mjs           — записать изменения в файл
//          node scripts/typography.mjs --check    — только проверить (exit 1, если
//                                                    строки требуют обработки)
// Функция `typography()` и `transform()` экспортируются для юнит-тестов.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

// Вставляем именно литерал-эскейп из 6 символов « », а не сам байт U+00A0 —
// так неразрывный пробел виден в diff и его можно отревьюить.
const NBSP = '\\u00A0';

/**
 * Чистая идемпотентная типографика для текста ОДНОГО строкового литерала.
 * Каждое правило ищет обычный пробел (U+0020); после подстановки ` `
 * повторный прогон уже ничего не находит.
 */
export function typography(text) {
  return (
    text
      // 1. Короткие слова (1–2 буквы: предлоги/союзы) приклеиваем к следующему
      //    слову. Lookbehind — чтобы это было начало слова (не хвост длинного) и
      //    чтобы соседние короткие слова оба склеились («я и ты»).
      .replace(/(?<![^\s(«„"—])([а-яёА-ЯЁ]{1,2}) (?=\S)/gu, `$1${NBSP}`)
      // 2. Тире не должно начинать строку — неразрывный пробел ПЕРЕД тире (после
      //    тире пробел обычный, там перенос допустим).
      .replace(/ —/g, `${NBSP}—`)
      // 3. Число и следующее за ним слово/единицу не разрываем («30 сек»).
      .replace(/(\d) (?=[а-яёА-ЯЁ])/gu, `$1${NBSP}`)
  );
}

const LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

// Диапазон исходника у объекта `editor.step` — литералы внутри пропускаем.
function findStepRange(sf) {
  let range = [Infinity, -Infinity];
  function walk(node) {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(sf) === 'editor' &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const p of node.initializer.properties) {
        if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'step') {
          range = [p.initializer.getStart(sf), p.initializer.getEnd()];
          return;
        }
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
  return range;
}

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

/** Обработать исходник strings.ts. Возвращает { output, changedKeys }. */
export function transform(source) {
  const sf = ts.createSourceFile('strings.ts', source, ts.ScriptTarget.Latest, true);
  const [stepStart, stepEnd] = findStepRange(sf);
  const edits = [];

  function visit(node) {
    if (LITERAL_KINDS.has(node.kind)) {
      const nodeStart = node.getStart(sf);
      const nodeEnd = node.getEnd();
      const insideStep = nodeStart >= stepStart && nodeEnd <= stepEnd;
      if (!insideStep) {
        const [start, end] = innerRange(node, sf);
        const inner = source.slice(start, end);
        const out = typography(inner);
        if (out !== inner) edits.push({ start, end, out, key: keyPathOf(node, sf) });
      }
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

function main() {
  const check = process.argv.includes('--check');
  const file = resolve(dirname(fileURLToPath(import.meta.url)), '../src/strings.ts');
  const source = readFileSync(file, 'utf8');
  const { output, changedKeys } = transform(source);

  if (check) {
    if (output !== source) {
      console.error(
        'typo:check — строки требуют неразрывных пробелов (запусти `npm run typo`):',
      );
      for (const k of changedKeys) console.error('  ' + k);
      process.exit(1);
    }
    console.log('typo:check — OK, все строки уже обработаны.');
    return;
  }

  if (output !== source) {
    writeFileSync(file, output, 'utf8');
    console.log(`typo — обработано строк: ${changedKeys.length}`);
    for (const k of changedKeys) console.log('  ' + k);
  } else {
    console.log('typo — изменений нет.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
