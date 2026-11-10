/**
 * The panel resolves the theme in an inline script before first paint, so a
 * wrong default shows as a flash. This exercises that script in a fake DOM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_HTML } from "../src/admin-ui.ts";

/** Pull the first <script> block out of the head, which is the theme bootstrap. */
function bootstrapScript(): string {
  const head = ADMIN_HTML.slice(0, ADMIN_HTML.indexOf("<style>"));
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

  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "document", "localStorage", bootstrapScript());
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
  assert.match(ADMIN_HTML, /const THEME_MODES = \["auto", "light", "dark"\]/);
  assert.match(ADMIN_HTML, /跟随系统/);
  // The OS change listener must only repaint while in auto mode.
  assert.match(ADMIN_HTML, /addEventListener\("change"/);
});
