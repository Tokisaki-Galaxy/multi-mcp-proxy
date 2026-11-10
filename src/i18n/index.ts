/**
 * Locale resolution, interpolation and plural handling.
 *
 * Deliberately dependency free: a Worker bundle on the free plan should not
 * carry an i18n runtime. `Intl.PluralRules` is available in workerd, so plural
 * forms come from the platform rather than hand-written rules.
 */

import { en, type Catalog, type MessageKey } from "./en";
import { zh } from "./zh";
import { ja } from "./ja";
import { de } from "./de";
import { fr } from "./fr";

export const CATALOGS: Record<string, Catalog> = { en, zh, ja, de, fr };

export type { MessageKey, Catalog };

/** Locale used when nothing else matches. */
export const DEFAULT_LOCALE = "en";

/**
 * Supported locales in display order, each with its endonym. The endonym is what
 * a language picker should show: someone looking for Japanese scans for 日本語,
 * not for the word "Japanese".
 */
export const LOCALES = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
  { code: "ja", label: "日本語" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

const CODES = new Set<string>(LOCALES.map((l) => l.code));

export function isLocale(value: unknown): value is LocaleCode {
  return typeof value === "string" && CODES.has(value);
}

/**
 * Map a BCP 47 tag onto a supported locale.
 *
 * `zh-Hans-CN`, `zh-TW` and `zh` all collapse to `zh`. `pt-BR` collapses to
 * nothing, because partial coverage of a close-but-different language is worse
 * than English.
 */
export function fromTag(tag: string): LocaleCode | null {
  const lower = tag.trim().toLowerCase();
  if (!lower) return null;
  const base = lower.split("-")[0] ?? "";
  return isLocale(base) ? base : null;
}

/**
 * Pick a locale from an Accept-Language header.
 *
 * Honors q-values, skips `*`, and falls back to English. Chinese is special
 * cased so that a Traditional Chinese preference still lands on 中文 rather than
 * falling through to English.
 */
export function negotiate(acceptLanguage: string | null | undefined): LocaleCode {
  if (!acceptLanguage) return DEFAULT_LOCALE;

  const entries = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      let q = 1;
      for (const p of params) {
        const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
        if (m) {
          const parsed = Number(m[1]);
          if (Number.isFinite(parsed)) q = parsed;
        }
      }
      return { tag: (tag ?? "").trim(), q };
    })
    .filter((e) => e.tag && e.tag !== "*" && e.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const entry of entries) {
    const resolved = fromTag(entry.tag);
    if (resolved) return resolved;
  }

  return DEFAULT_LOCALE;
}

/** Replace `{name}` placeholders. Unknown names are left as written. */
export function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Look up a message. Falls back to English, then to the key itself, so a
 * missing translation degrades to readable text rather than a blank.
 */
export function t(
  locale: LocaleCode,
  key: MessageKey,
  vars?: Record<string, string | number>
): string {
  const primary = CATALOGS[locale]?.[key];
  const fallback = en[key];
  return format(primary ?? fallback ?? key, vars);
}

/**
 * Plural-aware lookup. Keys are stored as `<key>.one` / `<key>.other`, matching
 * the CLDR categories this project actually needs.
 */
export function tn(
  locale: LocaleCode,
  key: string,
  count: number,
  vars?: Record<string, string | number>
): string {
  const category = pluralCategory(locale, count);
  const withVars = { n: count, ...vars };
  const catalog = CATALOGS[locale] ?? en;
  const table = catalog as Record<string, string | undefined>;

  const candidates = [`${key}.${category}`, `${key}.other`, `${key}.one`];
  for (const candidate of candidates) {
    const value = table[candidate];
    if (value) return format(value, withVars);
  }

  const fallbackTable = en as Record<string, string | undefined>;
  for (const candidate of candidates) {
    const value = fallbackTable[candidate];
    if (value) return format(value, withVars);
  }

  return format(key, withVars);
}

function pluralCategory(locale: LocaleCode, count: number): string {
  try {
    return new Intl.PluralRules(locale).select(count);
  } catch {
    return count === 1 ? "one" : "other";
  }
}

/** Filled message table for one locale, safe to embed in a page. */
export function catalogFor(locale: LocaleCode): Record<string, string> {
  return { ...(CATALOGS[locale] ?? en) };
}
