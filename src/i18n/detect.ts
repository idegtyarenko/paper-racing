// Locale selection happens at STARTUP (not a runtime swap): priority is
// ?lang → saved choice → browser language → English as the default. A manual
// switch (setLocale) writes the choice to localStorage and reloads the page —
// that way the model (which hoists `strings` to module scope) and the static
// markup are guaranteed to use a single, consistent locale.
//
// Every access to browser globals is guarded: in node (unit tests) they don't
// exist, and detection falls back to 'en' — the same object the model and
// tests import.

export type LocaleCode = 'en' | 'ru' | 'be';

export const LOCALES: readonly LocaleCode[] = ['en', 'ru', 'be'];

/** localStorage key for the chosen locale (project convention: `pr-` prefix). */
const LOCALE_KEY = 'pr-locale';

/** BCP-47 tag for Intl/toLocaleString and the <html lang> attribute. */
const LOCALE_TAGS: Record<LocaleCode, string> = {
  en: 'en',
  ru: 'ru-RU',
  be: 'be-BY',
};

export function localeTagOf(code: LocaleCode): string {
  return LOCALE_TAGS[code];
}

function isLocale(v: string | null | undefined): v is LocaleCode {
  return v === 'en' || v === 'ru' || v === 'be';
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private browsing / localStorage unavailable — fail silently
  }
}

/** ?lang=en|ru|be from the URL (a test override that also works in prod). */
function localeFromQuery(): LocaleCode | null {
  if (typeof location === 'undefined') return null;
  try {
    const q = new URLSearchParams(location.search).get('lang');
    return isLocale(q) ? q : null;
  } catch {
    return null;
  }
}

/** The first of navigator.languages whose primary subtag is ru/be/en
 *  (otherwise null → en). */
function localeFromBrowser(): LocaleCode | null {
  if (typeof navigator === 'undefined') return null;
  const langs = navigator.languages ?? [navigator.language];
  for (const l of langs) {
    const primary = (l || '').split('-')[0].toLowerCase();
    if (isLocale(primary)) return primary;
  }
  return null;
}

/**
 * The active locale at startup. A valid ?lang is also saved to localStorage,
 * so the chosen language sticks across the session (and works as a manual
 * override via a shared link).
 */
export function detectLocale(): LocaleCode {
  const fromQuery = localeFromQuery();
  if (fromQuery) {
    safeSet(LOCALE_KEY, fromQuery);
    return fromQuery;
  }
  const saved = safeGet(LOCALE_KEY);
  if (isLocale(saved)) return saved;
  return localeFromBrowser() ?? 'en';
}

/** Manual language switch: save the choice and reload (dev helper / future UI). */
export function setLocale(code: LocaleCode): void {
  if (!isLocale(code)) return;
  safeSet(LOCALE_KEY, code);
  if (typeof location !== 'undefined') location.reload();
}
