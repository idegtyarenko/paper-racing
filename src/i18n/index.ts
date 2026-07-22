// Locale entry point: on import, we synchronously pick the active locale and
// export it as `strings`. All consumers write `import { strings } from
// '.../i18n'` — same as they used to import strings.ts, except now it's the
// chosen language. Changing language means a reload (see detect.ts), so
// picking it statically at import time is safe both for model-level hoists
// (game.ts NAMES, editor.ts MSG) and for the one-shot localizeDom.

import { en, type Strings } from './en';
import { ru } from './ru';
import { be } from './be';
import { detectLocale, localeTagOf, setLocale, type LocaleCode } from './detect';

const LOCALE_OBJECTS: Record<LocaleCode, Strings> = { en, ru, be };

/** The active locale (chosen once at startup). */
export const locale: LocaleCode = detectLocale();

/** Strings for the chosen locale. */
export const strings: Strings = LOCALE_OBJECTS[locale];

/** BCP-47 tag for the active locale — for <html lang>. */
export const localeTag: string = localeTagOf(locale);

/**
 * Locale used for formatting dates/numbers (toLocaleString). For English,
 * `undefined`: we defer to the system's regional setting (M/D/Y for a US
 * user, D/M/Y elsewhere). For ru/be, an explicit tag, so the date format
 * matches the interface language.
 */
export const dateLocale: string | undefined = locale === 'en' ? undefined : localeTag;

export type { Strings, LocaleCode };
export { setLocale };
