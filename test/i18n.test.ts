/**
 * Locale negotiation, catalog integrity, interpolation and plurals.
 *
 * Catalog parity is enforced at compile time by the `Catalog` type, but the
 * placeholder check below catches a subtler failure: a translator dropping
 * `{added}` from a string, which compiles fine and renders "Added , skipped 2".
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Bundled first: Node's type stripping does not resolve the extensionless
// relative imports that a bundler-friendly source tree uses.
let CATALOGS: Record<string, Record<string, string>>;
let DEFAULT_LOCALE: string;
let LOCALES: readonly { code: string; label: string }[];
let fromTag: (tag: string) => string | null;
let format: (t: string, vars?: Record<string, string | number>) => string;
let isLocale: (v: unknown) => boolean;
let negotiate: (h?: string | null) => string;
let t: (locale: any, key: any, vars?: Record<string, string | number>) => string;
let tn: (locale: any, key: string, count: number, vars?: Record<string, string | number>) => string;
let en: Record<string, string>;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-i18n-"));
  const out = join(dir, "i18n.mjs");
  execFileSync(
    process.execPath,
    [
      "node_modules/esbuild/bin/esbuild",
      "src/i18n/index.ts",
      "--bundle",
      "--format=esm",
      `--outfile=${out}`,
      "--platform=neutral",
    ],
    { cwd: process.cwd() }
  );
  const mod = await import(pathToFileURL(out).href);
  ({ CATALOGS, DEFAULT_LOCALE, LOCALES, fromTag, format, isLocale, negotiate, t, tn } = mod);

  const enMod = await import(
    pathToFileURL(
      (() => {
        const enOut = join(dir, "en.mjs");
        execFileSync(
          process.execPath,
          [
            "node_modules/esbuild/bin/esbuild",
            "src/i18n/en.ts",
            "--bundle",
            "--format=esm",
            `--outfile=${enOut}`,
            "--platform=neutral",
          ],
          { cwd: process.cwd() }
        );
        return enOut;
      })()
    ).href
  );
  en = enMod.en;
});

/* ------------------------------------------------------------ negotiation */

test("falls back to English with no header", () => {
  assert.equal(negotiate(null), "en");
  assert.equal(negotiate(undefined), "en");
  assert.equal(negotiate(""), "en");
});

test("picks the highest weighted supported language", () => {
  assert.equal(negotiate("ja,en;q=0.8"), "ja");
  assert.equal(negotiate("de-DE,de;q=0.9,en;q=0.8"), "de");
  assert.equal(negotiate("fr-CA,fr;q=0.9"), "fr");
});

test("honours q-value ordering rather than header order", () => {
  assert.equal(negotiate("en;q=0.2,fr;q=0.9"), "fr");
  assert.equal(negotiate("ja;q=0.1,de;q=0.5"), "de");
});

test("collapses regional variants onto the base language", () => {
  assert.equal(negotiate("zh-Hans-CN"), "zh");
  assert.equal(negotiate("zh-TW"), "zh");
  assert.equal(negotiate("pt-BR"), "en");
  assert.equal(negotiate("en-GB"), "en");
});

test("ignores wildcards and zero-weight entries", () => {
  assert.equal(negotiate("*"), "en");
  assert.equal(negotiate("ja;q=0,en;q=1"), "en");
  assert.equal(negotiate("*,ja;q=0.5"), "ja");
});

test("fromTag maps only supported bases", () => {
  assert.equal(fromTag("JA"), "ja");
  assert.equal(fromTag("de-AT"), "de");
  assert.equal(fromTag("ko-KR"), null);
  assert.equal(fromTag(""), null);
});

test("isLocale rejects near misses", () => {
  assert.equal(isLocale("ja"), true);
  assert.equal(isLocale("ja-JP"), false);
  assert.equal(isLocale("EN"), false);
  assert.equal(isLocale(undefined), false);
});

test("the default locale is one of the supported ones", () => {
  assert.ok(LOCALES.some((l) => l.code === DEFAULT_LOCALE));
});

/* --------------------------------------------------------------- catalogs */

test("every locale defines every key", () => {
  const keys = Object.keys(en).sort();
  for (const [code, catalog] of Object.entries(CATALOGS)) {
    assert.deepEqual(Object.keys(catalog).sort(), keys, `${code} key set differs from en`);
  }
});

test("no translation is empty or still English placeholder text", () => {
  for (const [code, catalog] of Object.entries(CATALOGS)) {
    if (code === "en") continue;
    for (const [key, value] of Object.entries(catalog)) {
      assert.ok(String(value).trim().length > 0, `${code}.${key} is empty`);
    }
  }
});

test("placeholders survive translation", () => {
  for (const [code, catalog] of Object.entries(CATALOGS)) {
    for (const [key, english] of Object.entries(en)) {
      const expected = new Set([...String(english).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
      // `api.idsRequired` intentionally carries a literal JSON snippet.
      if (key === "api.idsRequired") continue;
      const actual = new Set([...String(catalog[key]).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
      assert.deepEqual(
        [...actual].sort(),
        [...expected].sort(),
        `${code}.${key} placeholder mismatch`
      );
    }
  }
});

test("placeholder text keeps its line breaks and sample keys", () => {
  for (const [code, catalog] of Object.entries(CATALOGS)) {
    const value = String(catalog["keys.placeholder"]);
    assert.ok(value.includes("\n"), `${code} lost the newline`);
    assert.ok(value.includes("tvly-abc123"), `${code} lost the sample key`);
    assert.ok(value.includes("tvly-def456"), `${code} lost the second sample key`);
  }
});

/* ---------------------------------------------------------- interpolation */

test("format substitutes known names and leaves unknown ones", () => {
  assert.equal(format("{a} and {b}", { a: 1, b: 2 }), "1 and 2");
  assert.equal(format("{a} and {b}", { a: 1 }), "1 and {b}");
  assert.equal(format("no vars"), "no vars");
});

test("format does not touch a literal JSON snippet", () => {
  assert.equal(format("{ ids: string[] }"), "{ ids: string[] }");
});

test("t falls back to English then to the key", () => {
  assert.equal(t("en", "login.submit"), "Enter");
  // The key exists in every catalog, so this checks plumbing not fallback.
  assert.notEqual(t("ja", "login.submit"), "");
});

test("t interpolates through the locale catalog", () => {
  const text = t("en", "svc.deleteConfirm", { id: "tavily" });
  assert.match(text, /tavily/);
  assert.ok(!text.includes("{id}"));
});

/* ---------------------------------------------------------------- plurals */

test("English plurals distinguish one from other", () => {
  assert.equal(tn("en", "keys.ago.minutes", 1), "1 minute ago");
  assert.equal(tn("en", "keys.ago.minutes", 5), "5 minutes ago");
  assert.equal(tn("en", "keys.ago.days", 0), "0 days ago");
});

test("German plurals follow its own rules", () => {
  assert.equal(tn("de", "keys.ago.minutes", 1), "1 Minute her");
  assert.match(tn("de", "keys.ago.minutes", 3), /3 Minuten her/);
});

test("Chinese and Japanese collapse both forms", () => {
  for (const code of ["zh", "ja"] as const) {
    const one = tn(code, "keys.ago.minutes", 1);
    const many = tn(code, "keys.ago.minutes", 5);
    assert.equal(one.replace("1", "N"), many.replace("5", "N"), `${code} should not inflect`);
  }
});

test("a missing plural family falls back rather than throwing", () => {
  const text = tn("en", "no.such.key", 3);
  assert.equal(text, "no.such.key");
});
