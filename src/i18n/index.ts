// Точка входа локалей: на импорте синхронно выбираем активную локаль и экспортируем
// её как `strings`. Все потребители пишут `import { strings } from '.../i18n'` — как
// раньше импортировали strings.ts, только теперь это выбранный язык. Смена языка =
// перезагрузка (см. detect.ts), поэтому статический выбор на импорте безопасен и для
// модельных хойстов (game.ts NAMES, editor.ts MSG), и для однократного localizeDom.

import { en, type Strings } from './en';
import { ru } from './ru';
import { be } from './be';
import { detectLocale, localeTagOf, setLocale, type LocaleCode } from './detect';

const LOCALE_OBJECTS: Record<LocaleCode, Strings> = { en, ru, be };

/** Активная локаль (выбрана один раз на старте). */
export const locale: LocaleCode = detectLocale();

/** Тексты выбранной локали. */
export const strings: Strings = LOCALE_OBJECTS[locale];

/** BCP-47 тег активной локали — для <html lang>. */
export const localeTag: string = localeTagOf(locale);

/**
 * Локаль для форматирования дат/чисел (toLocaleString). Для английского — `undefined`:
 * берём системную региональную настройку (у американца — M/D/Y, в других странах —
 * D/M/Y). Для ru/be — явный тег, чтобы дата совпадала с языком интерфейса.
 */
export const dateLocale: string | undefined = locale === 'en' ? undefined : localeTag;

export type { Strings, LocaleCode };
export { setLocale };
