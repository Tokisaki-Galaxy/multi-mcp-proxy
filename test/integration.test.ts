/**
 * Integration smoke test.
 *
 * Boots the bundled worker inside Miniflare with real KV, a SQLite-backed
 * Durable Object and real bindings, then drives it over HTTP against a local
 * stand-in upstream. This is the only test that exercises the actual replay
 * path end to end.
 *
 * Run with: node --test test/integration.test.ts
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const run = promisify(execFile);

const PROXY_KEY = "test-proxy-key";
const ENCRYPTION_KEY = "test-encryption-key-please-change";

interface Seen {
  url: string;
  auth: string | null;
  apiKey: string | null;
  body: string;
  accept: string | null;
}

interface ScriptedReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

let mf: any;
let upstream: Server;
let base = "";
let upstreamUrl = "";
let workDir = "";

const seen: Seen[] = [];
let script: (n: number) => ScriptedReply = () => ({
  status: 200,
  headers: { "content-type": "text/event-stream" },
  body: 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n',
});

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mmp-int-"));
  const bundlePath = join(workDir, "worker.mjs");

  await run(
    process.execPath,
    [
      "node_modules/esbuild/bin/esbuild",
      "src/index.ts",
      "--bundle",
      "--format=esm",
      "--platform=neutral",
      "--conditions=workerd,worker,browser",
      `--outfile=${bundlePath}`,
      "--external:cloudflare:*",
    ],
    { cwd: process.cwd() }
  );

  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        url: req.url ?? "",
        auth: req.headers.authorization ?? null,
        apiKey: (req.headers["x-api-key"] as string) ?? null,
        body: Buffer.concat(chunks).toString("utf8"),
        accept: (req.headers.accept as string) ?? null,
      });
      const reply = script(seen.length - 1);
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
    });
  });

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;

  const { Miniflare } = await import("miniflare");
  mf = new Miniflare({
    modules: true,
    scriptPath: bundlePath,
    compatibilityDate: "2026-01-01",
    compatibilityFlags: ["nodejs_compat"],
    kvNamespaces: ["REGISTRY"],
    durableObjects: { KEY_POOL: { className: "KeyPool", useSQLite: true } },
    bindings: { PROXY_KEY, ENCRYPTION_KEY },
  });

  base = (await mf.ready).toString().replace(/\/$/, "");
});

after(async () => {
  await mf?.dispose();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

async function api(path: string, body?: unknown, method?: string) {
  return fetch(base + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", "x-proxy-key": PROXY_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function sse(payload: unknown): ScriptedReply {
  return {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
  };
}

test("rejects a proxy call with no key", async () => {
  const res = await fetch(base + "/svc/mcp", { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
});

test("rejects a proxy call with a wrong key", async () => {
  const res = await fetch(base + "/svc/mcp", {
    method: "POST",
    headers: { "x-proxy-key": "wrong" },
    body: "{}",
  });
  assert.equal(res.status, 401);
});

test("serves the admin panel without auth", async () => {
  const res = await fetch(base + "/admin");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /multi-mcp-proxy/);
});

test("creates a service", async () => {
  const res = await api("/api/services", {
    id: "svc",
    name: "Test Service",
    upstreamUrl,
    auth: { type: "header", name: "x-api-key" },
    quota: {
      exhaustedStatuses: [402, 432],
      cooldownStatuses: [429],
      invalidStatuses: [401],
      reset: "month",
    },
  });
  assert.equal(res.status, 200);

  const list = (await (await api("/api/services")).json()) as any;
  assert.equal(list.services.length, 1);
  assert.equal(list.services[0].id, "svc");
  assert.equal(list.services[0].stats.total, 0);
});

test("rejects an invalid service id", async () => {
  const res = await api("/api/services", { id: "Admin", upstreamUrl: "https://x.test/mcp" });
  assert.equal(res.status, 400);
});

test("adds keys in bulk and never echoes a secret", async () => {
  const res = await api("/api/services/svc/keys", { keys: "key-aaaa-1111\nkey-bbbb-2222" });
  assert.equal(((await res.json()) as any).added, 2);

  const listed = (await (await api("/api/services/svc/keys")).json()) as any;
  assert.equal(listed.keys.length, 2);
  assert.equal(JSON.stringify(listed).includes("key-aaaa-1111"), false);
});

test("deduplicates the same key pasted twice", async () => {
  const res = await api("/api/services/svc/keys", { keys: "key-aaaa-1111" });
  const data = (await res.json()) as any;
  assert.equal(data.added, 0);
  assert.equal(data.skipped, 1);
});

test("injects the pooled credential and forwards the body untouched", async () => {
  script = () => sse({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "ok" }] } });
  seen.length = 0;

  const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" });
  const res = await fetch(base + "/svc/mcp", {
    method: "POST",
    headers: {
      "x-proxy-key": PROXY_KEY,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": "client-supplied-key",
    },
    body,
  });

  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.body, body, "request body was modified");
  assert.notEqual(seen[0]!.apiKey, "client-supplied-key", "client credential leaked through");
  assert.ok(seen[0]!.apiKey?.startsWith("key-"), "pooled key was not injected");
});

test("replays with the next key when the first one is reported invalid", async () => {
  // Answer 1 is the shape Firecrawl and Exa actually use: HTTP 200, error in body.
  script = (n) =>
    n === 0
      ? sse({
          result: {
            content: [{ type: "text", text: "The API key is invalid or revoked." }],
            isError: true,
          },
          jsonrpc: "2.0",
          id: 9,
        })
      : sse({ result: { content: [{ type: "text", text: "real answer" }] }, jsonrpc: "2.0", id: 9 });

  seen.length = 0;
  const beforeKeys = (await (await api("/api/services/svc/keys")).json()) as any;
  const invalidBefore = beforeKeys.keys.filter((k: any) => k.status === "invalid").length;

  const res = await fetch(base + "/svc/mcp", {
    method: "POST",
    headers: {
      "x-proxy-key": PROXY_KEY,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "x", arguments: {} } }),
  });

  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /real answer/);
  assert.equal(seen.length, 2, "expected exactly one replay");
  assert.notEqual(seen[0]!.apiKey, seen[1]!.apiKey, "replay reused the same key");

  const afterKeys = (await (await api("/api/services/svc/keys")).json()) as any;
  const invalidAfter = afterKeys.keys.filter((k: any) => k.status === "invalid").length;
  assert.equal(invalidAfter, invalidBefore + 1, "the failing key was not retired");
});

test("widens a narrow Accept header for strict upstreams", async () => {
  script = () => sse({ jsonrpc: "2.0", id: 1, result: {} });
  seen.length = 0;

  await fetch(base + "/svc/mcp", {
    method: "POST",
    headers: { "x-proxy-key": PROXY_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  assert.ok(seen[0]!.accept?.includes("text/event-stream"), "accept was not widened");
});

test("does not replay a 4xx client error", async () => {
  script = () => ({
    status: 400,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "server-error",
      error: { code: -32600, message: "Missing mcp-session-id header." },
    }),
  });
  seen.length = 0;

  const res = await fetch(base + "/svc/mcp", {
    method: "POST",
    headers: { "x-proxy-key": PROXY_KEY, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
  });

  assert.equal(res.status, 400);
  assert.equal(seen.length, 1, "a client error must not be replayed");
});

test("honours a 429 with Retry-After by cooling the key", async () => {
  script = () => ({ status: 429, headers: { "retry-after": "30" }, body: "" });
  seen.length = 0;

  await fetch(base + "/svc/mcp", {
    method: "POST",
    headers: { "x-proxy-key": PROXY_KEY, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
  });

  const keys = (await (await api("/api/services/svc/keys")).json()) as any;
  const now = Math.floor(Date.now() / 1000);
  const cooled = keys.keys.filter((k: any) => k.cooldownUntil > now);
  assert.equal(cooled.length, 1, "expected exactly one cooling key");
});

test("returns 404 for an unknown service", async () => {
  const res = await fetch(base + "/nope/mcp", {
    method: "POST",
    headers: { "x-proxy-key": PROXY_KEY, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 404);
});

test("refuses proxy calls when the service is disabled", async () => {
  await api("/api/services", {
    id: "off",
    name: "Off",
    upstreamUrl,
    enabled: false,
    auth: { type: "header", name: "x-api-key" },
  });
  const res = await fetch(base + "/off/mcp", {
    method: "POST",
    headers: { "x-proxy-key": PROXY_KEY, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 503);
});

test("deletes a service", async () => {
  const res = await api("/api/services/off", undefined, "DELETE");
  assert.equal(res.status, 200);
  const list = (await (await api("/api/services")).json()) as any;
  assert.equal(list.services.some((s: any) => s.id === "off"), false);
});
