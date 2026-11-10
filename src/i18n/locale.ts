/**
 * Locale persistence and the language picker.
 *
 * Order of preference: an explicit `?lang=` query parameter, then the cookie set
 * by the picker, then the browser's Accept-Language. Putting the query parameter
 * first makes shared links deterministic, which matters when someone links a
 * screenshot of the panel in a language the reader may not use.
 */

import { isLocale, LOCALES, type LocaleCode } from "./index";

export const LANG_COOKIE = "mmp_lang";
export const LANG_QUERY = "lang";

/** Parse a Cookie header without pulling in a cookie library. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/** Build the Set-Cookie value for a chosen locale. */
export function langCookie(value: LocaleCode): string {
  // One year, path-wide, and not httpOnly so the picker can rewrite it without
  // a round trip. It carries no secret.
  return `${LANG_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

/** Locale for a Set-Cookie header, or null when the cookie should be cleared. */
export function explicitLocale(
  query: string | null | undefined,
  cookie: string | null | undefined
): LocaleCode | null {
  if (isLocale(query)) return query;
  if (isLocale(cookie)) return cookie;
  return null;
}

/**
 * Render the language <select> options. The endonym is shown so a reader can
 * find their own language without knowing the current one.
 */
export function localeOptions(current: LocaleCode): string {
  return LOCALES.map(({ code, label }) => {
    const selected = code === current ? " selected" : "";
    return `<option value="${code}"${selected}>${label}</option>`;
  }).join("");
}
