/**
 * End-to-end check against a real hosted MCP endpoint.
 *
 * Uses Exa because it answers without a valid key at a lower rate limit, so
 * the whole chain can be exercised without spending anyone's quota. Two fake
 * keys are loaded ahead of it; the first one must be retired and the request
 * replayed onto the second. The replayed request is `initialize`, a protocol
 * method. A `tools/call` is only replayed for a tool the server annotated as
 * read-only or idempotent, and step 4 shows the default: no tool list was
 * fetched, so the call is not replayed.
 *
 * Run: node scripts/e2e-exa.mjs
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";

const run = promisify(execFile);
const PROXY_KEY = "e2e-key";

const workDir = await mkdtemp(join(tmpdir(), "mmp-e2e-"));
const bundlePath = join(workDir, "worker.mjs");

await run(
  process.execPath,
  [
    "node_modules/esbuild/bin/esbuild", "src/index.ts", "--bundle", "--format=esm",
    "--platform=neutral", "--conditions=workerd,worker,browser",
    `--outfile=${bundlePath}`, "--external:cloudflare:*",
  ],
  { cwd: process.cwd() }
);

const mf = new Miniflare({
  modules: true,
  scriptPath: bundlePath,
  compatibilityDate: "2026-01-01",
  compatibilityFlags: ["nodejs_compat"],
  kvNamespaces: ["REGISTRY"],
  durableObjects: { KEY_POOL: { className: "KeyPool", useSQLite: true } },
  bindings: { PROXY_KEY, ENCRYPTION_KEY: "e2e-encryption-material" },
});

const base = (await mf.ready).toString().replace(/\/$/, "");
const H = { "content-type": "application/json", "x-proxy-key": PROXY_KEY };

async function call(path, body, method) {
  return fetch(base + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

console.log("1. 注册 Exa 服务");
let res = await call("/api/services", {
  id: "exa",
  name: "Exa",
  upstreamUrl: "https://mcp.exa.ai/mcp",
  auth: { type: "header", name: "x-api-key" },
  quota: {
    exhaustedStatuses: [402],
    cooldownStatuses: [429],
    invalidStatuses: [401],
    reset: "month",
  },
});
console.log("   ", res.status, await res.text());

console.log("2. 注入两把假 key，验证真实重放路径");
res = await call("/api/services/exa/keys", {
  keys: "deliberately-invalid-exa-key-1\ndeliberately-invalid-exa-key-2",
});
console.log("   ", res.status, await res.text());

console.log("3. 走代理执行 initialize（协议方法，假 key 应被淘汰并重放）");
res = await fetch(base + "/exa/mcp", {
  method: "POST",
  headers: {
    "x-proxy-key": PROXY_KEY,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
  }),
});
console.log("   status", res.status, "attempts", res.headers.get("x-proxy-attempts"));
const initText = await res.text();
console.log("   body", initText.slice(0, 200).replace(/\n/g, " | "));
const sessionId = res.headers.get("mcp-session-id");

console.log("4. 走代理执行 tools/call（仅当上游给该工具标了只读或幂等才会重放）");
res = await fetch(base + "/exa/mcp", {
  method: "POST",
  headers: {
    "x-proxy-key": PROXY_KEY,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "web_search_exa", arguments: { query: "cloudflare workers durable objects", numResults: 1 } },
  }),
});
console.log("   status", res.status, "attempts", res.headers.get("x-proxy-attempts"));
const callText = await res.text();
console.log("   body", callText.slice(0, 400).replace(/\n/g, " | "));

console.log("5. 查看密钥池状态");
res = await call("/api/services/exa/keys");
const pool = await res.json();
for (const k of pool.keys) {
  console.log(`    ${k.id} mask=${k.mask} status=${k.status} useCount=${k.useCount} lastError=${(k.lastError ?? "").slice(0, 60)}`);
}

await mf.dispose();
