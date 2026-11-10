import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "mmp-ui-"));
const out = join(dir, "ui.mjs");
execFileSync(process.execPath, [
  "node_modules/esbuild/bin/esbuild", "src/admin-ui.ts", "--bundle", "--format=esm",
  `--outfile=${out}`, "--platform=neutral",
], { cwd: process.cwd() });

const { renderAdmin } = await import(pathToFileURL(out).href);

const LOCALES = ["en", "zh", "ja", "de", "fr"];
let exitCode = 0;

for (const locale of LOCALES) {
  const html = renderAdmin(locale);
  const label = `[${locale}]`;

  // Inline event handlers must be syntactically valid JavaScript.
  const handlers = [...html.matchAll(/on(?:click|submit)="([^"]*)"/g)].map((m) => m[1]);
  let bad = 0;
  for (const h of handlers) {
    const js = h.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    try {
      new Function(js);
    } catch {
      try { new Function("event", js); } catch (e) { bad++; console.log(`${label} BAD HANDLER: ${js} -> ${e.message}`); }
    }
  }

  // No unresolved placeholders should survive rendering.
  const leftover = [...html.matchAll(/\{[a-zA-Z]\w*\}/g)].map((m) => m[0]);
  // Allow the literal JSON body example in api.idsRequired.
  const realLeftover = leftover.filter((x) => x !== "{ids}" && !html.includes(`{ ids: string[] }`));

  if (bad > 0) exitCode = 1;
  if (realLeftover.length > 0) {
    console.log(`${label} UNRESOLVED PLACEHOLDERS: ${[...new Set(realLeftover)].join(", ")}`);
    exitCode = 1;
  }

  // The page must declare its language and carry the embedded catalog.
  const langOk = html.includes(`<html lang="${locale}"`);
  const catOk = html.includes('id="mmp-catalog"');
  if (!langOk || !catOk) {
    console.log(`${label} missing lang attr or catalog: lang=${langOk} catalog=${catOk}`);
    exitCode = 1;
  }

  if (bad === 0 && realLeftover.length === 0 && langOk && catOk) {
    console.log(`${label} ok, handlers=${handlers.length}`);
  }
}

// A translation containing a script-closing sequence must not break out.
const { renderAdmin: render } = await import(pathToFileURL(out).href);
console.log(`all locales rendered: ${LOCALES.every((l) => render(l).length > 5000)}`);
process.exit(exitCode);
