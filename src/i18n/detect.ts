// Выбор локали на СТАРТЕ (не рантайм-своп): приоритет ?lang → сохранённый выбор →
// язык браузера → английский по умолчанию. Ручная смена (setLocale) пишет выбор в
// localStorage и перезагружает страницу — так модель (которая хойстит strings на
// уровень модуля) и статическая разметка гарантированно берут одну локаль.
//
// Все обращения к браузерным глобалам защищены: в node (юнит-тесты) их нет, и тогда
// детект отдаёт 'en' — тот же объект, что импортируют модель и тесты.

export type LocaleCode = 'en' | 'ru' | 'be';

export const LOCALES: readonly LocaleCode[] = ['en', 'ru', 'be'];

/** localStorage-ключ выбранной локали (конвенция проекта — префикс `pr-`). */
const LOCALE_KEY = 'pr-locale';

/** BCP-47 тег для Intl/toLocaleString и атрибута <html lang>. */
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
    // приватный режим / недоступный localStorage — молча пропускаем
  }
}

/** ?lang=en|ru|be из URL (тест-override, работает и в проде). */
function localeFromQuery(): LocaleCode | null {
  if (typeof location === 'undefined') return null;
  try {
    const q = new URLSearchParams(location.search).get('lang');
    return isLocale(q) ? q : null;
  } catch {
    return null;
  }
}

/** Первый из navigator.languages, чей основной субтег — ru/be/en (иначе null → en). */
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
 * Активная локаль на старте. Валидный ?lang также сохраняется в localStorage, чтобы
 * держаться выбранного языка по сессии (и работать как ручной override по ссылке).
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

/** Ручная смена языка: сохранить выбор и перезагрузить (dev-хелпер / будущий UI). */
export function setLocale(code: LocaleCode): void {
  if (!isLocale(code)) return;
  safeSet(LOCALE_KEY, code);
  if (typeof location !== 'undefined') location.reload();
}
