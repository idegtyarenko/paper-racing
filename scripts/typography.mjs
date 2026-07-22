// Typography build tool: inserts non-breaking spaces (U+00A0) into the string
// literals of the locale files `src/i18n/{ru,be,en}.ts`, so the layout never
// leaves a dangling short preposition/conjunction, a dangling dash, or a break
// between a number and its unit.
//
// Rules are per-locale (see LOCALE_RULES): Russian and Belarusian glue short
// words to the following word (the Belarusian letter class also includes
// `і`/`ў`); English doesn't glue short prepositions (only "number+unit" and a
// non-breaking space before a dash).
//
// Not a runtime step: the fix is baked straight into the source as the escape
// sequence ` ` (visible in diffs, so it's reviewable) — the app never computes
// this on the fly. Only touches the text of string literals (via the
// TypeScript AST) — leaves code, comments, and `${…}` interpolations alone.
//
// Usage: node scripts/typography.mjs           — write changes to the locale files
//        node scripts/typography.mjs --check    — check only (exits 1 if any
//                                                  strings still need fixing)
// `typography()`, `transform()`, and `LOCALE_RULES` are exported for tests.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

// We insert the literal 6-character escape sequence ` `, not the raw U+00A0
// byte — that way the non-breaking space is visible in diffs and reviewable.
const NBSP = '\\u00A0';

/**
 * Per-locale typography rules:
 *  - wordClass — the letter class used by the "short word" and "number+unit"
 *    rules. Belarusian adds `і` (U+0456), `ў` (U+045E), and their uppercase
 *    forms — otherwise `і` (a common conjunction, "and") and words containing
 *    `ў` wouldn't be caught by the Russian class `[а-яё]`.
 *  - shortWords — whether to glue 1-2 letter prepositions/conjunctions to the
 *    following word. English has no such convention — only "number+unit" and
 *    a non-breaking space before a dash apply.
 */
export const LOCALE_RULES = {
  ru: { wordClass: 'а-яёА-ЯЁ', shortWords: true },
  be: { wordClass: 'а-яёіўА-ЯЁІЎ', shortWords: true },
  en: { wordClass: 'a-zA-Z', shortWords: false },
};

/**
 * Pure, idempotent typography pass over the text of a SINGLE string literal,
 * under a locale's rules. Each rule looks for a regular space (U+0020); once
 * it's replaced with ` `, a second run finds nothing left to do.
 */
export function typography(text, rules = LOCALE_RULES.ru) {
  const { wordClass, shortWords } = rules;
  let out = text;
  // 1. Glue short words (1-2 letter prepositions/conjunctions) to the next word.
  //    The lookbehind ensures this is the start of a word (not the tail of a
  //    longer one) and lets adjacent short words both get glued ("я и ты").
  //    Only applies to locales with shortWords.
  if (shortWords) {
    out = out.replace(
      new RegExp(`(?<![^\\s(«„"—])([${wordClass}]{1,2}) (?=\\S)`, 'gu'),
      `$1${NBSP}`,
    );
  }
  // 2. A dash should never start a line — non-breaking space BEFORE the dash
  //    (a regular space after it is fine, wrapping there is OK). Applies to
  //    every locale.
  out = out.replace(/ —/g, `${NBSP}—`);
  // 3. Don't break a number from the word/unit that follows it ("30 сек" / "30 sec").
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

// The literal's dotted path (for the --check report): collect property-assignment names up the tree.
function keyPathOf(node, sf) {
  const parts = [];
  for (let n = node; n; n = n.parent) {
    if (ts.isPropertyAssignment(n)) parts.unshift(n.name.getText(sf));
  }
  return parts.join('.') || '(literal)';
}

// Bounds of the literal's INNER text (excluding quotes/backticks and `${`/`}`).
function innerRange(node, sf) {
  const start = node.getStart(sf) + 1; // after the opening quote/backtick/`}`
  let end = node.getEnd() - 1; // before the closing quote/backtick
  // TemplateHead/Middle end with `${` — trim two characters.
  if (
    node.kind === ts.SyntaxKind.TemplateHead ||
    node.kind === ts.SyntaxKind.TemplateMiddle
  ) {
    end = node.getEnd() - 2;
  }
  return [start, end];
}

/** Process a locale file's source under its rules. Returns { output, changedKeys }. */
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

  // Apply from the end backwards so offsets don't shift.
  edits.sort((a, b) => b.start - a.start);
  let output = source;
  for (const e of edits) output = output.slice(0, e.start) + e.out + output.slice(e.end);

  const changedKeys = [...new Set(edits.map((e) => e.key))].sort();
  return { output, changedKeys };
}

/** Locale files and their rules. */
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
        `typo:check — ${code}: strings need non-breaking spaces (run \`npm run typo\`):`,
      );
      for (const k of changedKeys) console.error('  ' + k);
    } else {
      writeFileSync(file, output, 'utf8');
      console.log(`typo — ${code}: strings processed: ${changedKeys.length}`);
      for (const k of changedKeys) console.log('  ' + k);
    }
  }

  if (check) {
    if (anyChanged) process.exit(1);
    console.log('typo:check — OK, all locales already processed.');
  } else if (!anyChanged) {
    console.log('typo — no changes.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
