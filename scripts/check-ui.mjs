import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mmp-ui-"));
const out = join(dir, "ui.mjs");
execFileSync(process.execPath, [
  "node_modules/esbuild/bin/esbuild", "src/admin-ui.ts", "--bundle", "--format=esm",
  `--outfile=${out}`, "--platform=neutral",
], { cwd: process.cwd() });

import { pathToFileURL } from "node:url";
const { ADMIN_HTML } = await import(pathToFileURL(out).href);

// Collect every inline onclick/onsubmit and try to parse the JS in it.
const handlers = [...ADMIN_HTML.matchAll(/on(?:click|submit)="([^"]*)"/g)].map((m) => m[1]);
console.log("handler count:", handlers.length);

let bad = 0;
for (const h of handlers) {
  const js = h.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  try {
    new Function(js);
  } catch (e) {
    // onclick bodies like "login(); return false;" are valid only inside a function body,
    // so wrap once more before checking.
    try {
      new Function("event", js);
    } catch (e2) {
      bad++;
      console.log("BAD:", js, "->", e.message);
    }
  }
}
console.log("bad handlers:", bad);
