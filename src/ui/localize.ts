// Заполнение статичной разметки текстами из strings при старте. Так все тексты
// (включая кнопки и заголовки из index.html) живут в одном месте — strings.ts.
//
// В разметке проставлены атрибуты:
//   data-i18n="buttons.next"            → задаёт textContent
//   data-i18n-title="buttons.rulesTitle"→ задаёт атрибут title
//   data-i18n-aria-label="…"            → задаёт атрибут aria-label
// Ключ — путь по вложенному объекту strings через точку.

import { strings } from '../strings';

/** Резолв ключа вида "buttons.next" по вложенному объекту strings. */
function resolve(key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], strings);
  return typeof value === 'string' ? value : undefined;
}

/** Пройтись по всем [data-i18n*] узлам и проставить тексты/атрибуты из strings. */
export function localizeDom(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const text = resolve(el.dataset.i18n!);
    if (text !== undefined) el.textContent = text;
  });
  applyAttr(root, 'i18nTitle', 'data-i18n-title', 'title');
  applyAttr(root, 'i18nAriaLabel', 'data-i18n-aria-label', 'aria-label');
  applyAttr(root, 'i18nPlaceholder', 'data-i18n-placeholder', 'placeholder');
}

function applyAttr(
  root: ParentNode,
  datasetKey: string,
  selector: string,
  attr: string,
): void {
  root.querySelectorAll<HTMLElement>(`[${selector}]`).forEach((el) => {
    const text = resolve(el.dataset[datasetKey]!);
    if (text !== undefined) el.setAttribute(attr, text);
  });
}
