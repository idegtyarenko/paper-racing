// Fills static markup with text from strings at startup. This keeps all text
// (including buttons and headings from index.html) in one place — strings.ts.
//
// The markup carries these attributes:
//   data-i18n="buttons.next"            → sets textContent
//   data-i18n-title="buttons.rulesTitle"→ sets the title attribute
//   data-i18n-aria-label="…"            → sets the aria-label attribute
// The key is a dot-separated path into the nested strings object.

import { strings } from '../i18n';

/** Resolve a key like "buttons.next" against the nested strings object. */
function resolve(key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], strings);
  return typeof value === 'string' ? value : undefined;
}

/** Walk all [data-i18n*] nodes and set their text/attributes from strings. */
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
