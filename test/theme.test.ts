/**
 * The panel resolves the theme in an inline script before first paint, so a
 * wrong default shows as a flash. This exercises that script in a fake DOM.
 *
 * The panel is imported through esbuild rather than directly, because Node's
 * type stripping does not resolve directory imports like `./i18n`.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let renderAdmin: (locale: string) => string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-theme-"));
  const out = join(dir, "ui.mjs");
  execFileSync(
    process.execPath,
    [
      "node_modules/esbuild/bin/esbuild",
      "src/admin-ui.ts",
      "--bundle",
      "--format=esm",
      `--outfile=${out}`,
      "--platform=neutral",
    ],
    { cwd: process.cwd() }
  );
  const mod = await import(pathToFileURL(out).href);
  renderAdmin = mod.renderAdmin;
});

/** Pull the first <script> block out of the head, which is the theme bootstrap. */
function bootstrapScript(html: string): string {
  const head = html.slice(0, html.indexOf("<style>"));
  const match = head.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "bootstrap script not found in <head>");
  return match![1]!;
}

interface FakeResult {
  theme: string;
  mode: string;
  stored: string | null;
}

/** Run the bootstrap script against a fake environment. */
function run(saved: string | null, systemPrefersLight: boolean): FakeResult {
  const attrs: Record<string, string> = {};
  const doc = {
    documentElement: {
      setAttribute(name: string, value: string) {
        attrs[name] = value;
      },
      getAttribute(name: string) {
        return attrs[name] ?? null;
      },
    },
  };
  const win = {
    matchMedia(query: string) {
      assert.equal(query, "(prefers-color-scheme: light)");
      return { matches: systemPrefersLight };
    },
  };
  let stored: string | null = saved;
  const storage = {
    getItem: () => stored,
    setItem: (_k: string, v: string) => {
      stored = v;
    },
  };

  const script = bootstrapScript(renderAdmin("en"));
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "document", "localStorage", script);
  fn(win, doc, storage);

  return { theme: attrs["data-theme"] ?? "", mode: attrs["data-theme-mode"] ?? "", stored };
}

test("defaults to following the system when nothing is saved", () => {
  const r = run(null, false);
  assert.equal(r.theme, "dark");
  assert.equal(r.mode, "auto");
  // A first visit must not write a choice, otherwise it could never track the OS.
  assert.equal(r.stored, null);
});

test("follows a light system preference by default", () => {
  const r = run(null, true);
  assert.equal(r.theme, "light");
  assert.equal(r.mode, "auto");
});

test("follows a dark system preference by default", () => {
  const r = run(null, false);
  assert.equal(r.theme, "dark");
  assert.equal(r.mode, "auto");
});

test("auto mode resolves against the system", () => {
  assert.equal(run("auto", true).theme, "light");
  assert.equal(run("auto", false).theme, "dark");
});

test("an explicit light choice beats a dark system", () => {
  const r = run("light", false);
  assert.equal(r.theme, "light");
  assert.equal(r.mode, "light");
});

test("an explicit dark choice beats a light system", () => {
  const r = run("dark", true);
  assert.equal(r.theme, "dark");
  assert.equal(r.mode, "dark");
});

test("a junk saved value falls back to auto", () => {
  for (const junk of ["", "LIGHT", "solarized", "null", "1"]) {
    const r = run(junk, true);
    assert.equal(r.mode, "auto", `junk "${junk}" should not pin a mode`);
    assert.equal(r.theme, "light");
  }
});

test("the panel exposes a three-state theme control", () => {
  const html = renderAdmin("en");
  assert.match(html, /const THEME_MODES = \["auto", "light", "dark"\]/);
  assert.match(html, /theme\.mode\.auto/);
  // The OS change listener must only repaint while in auto mode.
  assert.match(html, /addEventListener\("change"/);
});

test("every locale declares its language on the root element", () => {
  for (const locale of ["en", "zh", "ja", "de", "fr"]) {
    assert.match(renderAdmin(locale), new RegExp(`<html lang="${locale}"`));
  }
});
