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
  /** Every header the upstream saw, lowercased. */
  headers: Record<string, string>;
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
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(",") : (v ?? "")])
        ),
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

test("admin panel follows Accept-Language", async () => {
  const cases: Array<[string, string, RegExp]> = [
    ["ja", "ja,en;q=0.8", /<html lang="ja"/],
    ["de", "de-DE,de;q=0.9", /<html lang="de"/],
    ["fr", "fr", /<html lang="fr"/],
    ["zh", "zh-CN", /<html lang="zh"/],
    ["en", "pt-BR", /<html lang="en"/],
  ];
  for (const [label, header, pattern] of cases) {
    const res = await fetch(base + "/admin", { headers: { "accept-language": header } });
    const html = await res.text();
    assert.equal(res.status, 200, label);
    assert.match(html, pattern, label);
    assert.equal(res.headers.get("content-language"), label, label);
    assert.match(res.headers.get("vary") ?? "", /Accept-Language/i, label);
  }
});

test("an explicit ?lang wins and is persisted in a cookie", async () => {
  const res = await fetch(base + "/admin?lang=ja", {
    headers: { "accept-language": "de" },
  });
  assert.equal(res.headers.get("content-language"), "ja");
  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, /mmp_lang=ja/);
  assert.match(cookie, /Max-Age=/);
  await res.text();
});

test("the stored cookie beats the browser preference", async () => {
  const res = await fetch(base + "/admin", {
    headers: { "accept-language": "de", cookie: "mmp_lang=fr" },
  });
  assert.equal(res.headers.get("content-language"), "fr");
  await res.text();
  // A cookie read must not re-set the cookie, or every page load would rewrite it.
  assert.equal(res.headers.get("set-cookie"), null);
});

test("a junk lang parameter falls back instead of breaking", async () => {
  const res = await fetch(base + "/admin?lang=klingon", {
    headers: { "accept-language": "ja" },
  });
  assert.equal(res.headers.get("content-language"), "ja");
  assert.equal(res.headers.get("set-cookie"), null);
  await res.text();
});

test("api errors are localized", async () => {
  const res = await fetch(base + "/api/services", {
    headers: { "accept-language": "ja" },
  });
  assert.equal(res.status, 401);
  const body = (await res.json()) as any;
  // Japanese catalog for api.unauthorized is 未認証.
  assert.match(body.error, /認証/);
});

test("mcp route errors stay in English", async () => {
  // The consumer is a machine, so these are deliberately not translated.
  const res = await fetch(base + "/nope/mcp", {
    method: "POST",
    headers: { "x-proxy-key": PROXY_KEY, "content-type": "application/json", "accept-language": "ja" },
    body: "{}",
  });
  assert.equal(res.status, 404);
  const body = (await res.json()) as any;
  assert.match(body.error, /Unknown service/);
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

test("stores an optional note given after a comma", async () => {
  let res = await api("/api/services/svc/keys", { keys: "key-note-1,甲账号\nkey-note-2,乙账号" });
  assert.equal(((await res.json()) as any).added, 2);

  const listed = (await (await api("/api/services/svc/keys")).json()) as any;
  const notes = listed.keys.map((k: any) => k.label).filter(Boolean);
  assert.deepEqual(notes.sort(), ["乙账号", "甲账号"]);
  // The note must not leak the secret.
  assert.equal(JSON.stringify(listed).includes("key-note-1"), false);
  // Two different short keys must render differently, or the panel is useless.
  const masks = listed.keys.map((k: any) => k.mask);
  assert.equal(new Set(masks).size, masks.length);

  // Editing a note afterwards.
  const target = listed.keys.find((k: any) => k.label === "甲账号");
  res = await api(`/api/services/svc/keys/${target.id}`, { label: "甲账号改过" }, "PATCH");
  assert.equal(res.status, 200);

  const after = (await (await api("/api/services/svc/keys")).json()) as any;
  const updated = after.keys.find((k: any) => k.id === target.id);
  assert.equal(updated.label, "甲账号改过");

  // Clearing a note.
  await api(`/api/services/svc/keys/${target.id}`, { label: "" }, "PATCH");
  const cleared = (await (await api("/api/services/svc/keys")).json()) as any;
  assert.equal(cleared.keys.find((k: any) => k.id === target.id).label, "");
});

test("rejects a duplicated note inside one batch", async () => {
  const res = await api("/api/services/svc/keys", { keys: "key-dup-1,重复\nkey-dup-2,重复" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.match(body.error, /重复/);
});

test("usage sync reads real numbers through a configured probe", async () => {
  // A second local endpoint stands in for the provider's balance API.
  const { createServer } = await import("node:http");
  const balance = createServer((req, res) => {
    const key = req.headers["x-api-key"] as string;
    res.writeHead(200, { "content-type": "application/json" });
    // Mimic Firecrawl: plan credits plus what is left.
    res.end(JSON.stringify({ success: true, data: { planCredits: 1000, remainingCredits: key === "key-aaaa-1111" ? 600 : 250 } }));
  });
  await new Promise<void>((r) => balance.listen(0, "127.0.0.1", r));
  const balanceUrl = `http://127.0.0.1:${(balance.address() as any).port}/credit-usage`;

  try {
    const save = await api("/api/services", {
      id: "metered",
      name: "Metered",
      upstreamUrl,
      auth: { type: "header", name: "x-api-key" },
      usage: {
        url: balanceUrl,
        style: { type: "header", name: "x-api-key" },
        remainingPath: "data.remainingCredits",
        limitPath: "data.planCredits",
      },
    });
    assert.equal(save.status, 200);

    await api("/api/services/metered/keys", { keys: "key-aaaa-1111\nkey-bbbb-2222" });

    const synced = await api("/api/services/metered/keys/sync", {});
    const body = (await synced.json()) as any;
    assert.equal(synced.status, 200);
    assert.equal(body.synced, 2);
    assert.equal(body.failed, 0);

    const listed = (await (await api("/api/services/metered/keys")).json()) as any;
    const first = listed.keys.find((k: any) => k.mask.includes("1111"));
    assert.equal(first.quotaLimit, 1000);
    // remaining 600 of 1000 means 400 used.
    assert.equal(first.quotaUsed, 400);
    assert.ok(first.quotaSyncedAt > 0);

    await api("/api/services/metered", undefined, "DELETE");
  } finally {
    await new Promise<void>((r) => balance.close(() => r()));
  }
});

test("usage sync explains itself when no probe is configured", async () => {
  const res = await fetch(base + "/api/services/svc/keys/sync", {
    method: "POST",
    headers: { "x-proxy-key": PROXY_KEY, "accept-language": "ja" },
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  // Japanese catalog for api.noUsageProbe mentions the balance endpoint.
  assert.match(body.error, /エンドポイント/);
});

test("rejects a usage probe without a readable path", async () => {
  const res = await api("/api/services", {
    id: "badprobe",
    upstreamUrl,
    usage: { url: "https://api.example.com/usage", style: { type: "header", name: "x-api-key" } },
  });
  assert.equal(res.status, 400);
});

test("keeps the limit fallback path when saving a service", async () => {
  // Regression: the fallback was accepted by the type but dropped on save, so
  // Tavily's null key.limit could never resolve to account.plan_limit.
  const save = await api("/api/services", {
    id: "fallback",
    name: "Fallback",
    upstreamUrl,
    usage: {
      url: "https://api.tavily.com/usage",
      style: { type: "header", name: "Authorization", prefix: "Bearer " },
      usedPath: "key.usage",
      limitPath: "key.limit",
      limitFallbackPath: "account.plan_limit",
    },
  });
  assert.equal(save.status, 200);

  const listed = (await (await api("/api/services")).json()) as any;
  const svc = listed.services.find((s: any) => s.id === "fallback");
  assert.equal(svc.usage.limitFallbackPath, "account.plan_limit");

  await api("/api/services/fallback", undefined, "DELETE");
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

test("does not replay a body-level failure for an unannotated tool", async () => {
  // The shape Firecrawl and Exa actually use: HTTP 200, failure inside the body.
  // The mock counts one side effect per upstream hit, so a replay would show up
  // as two.
  let sideEffects = 0;
  script = () => {
    sideEffects += 1;
    return sse({
      result: {
        content: [{ type: "text", text: "rate limit exceeded after creating the job" }],
        isError: true,
      },
      jsonrpc: "2.0",
      id: 9,
    });
  };

  seen.length = 0;
  const beforeKeys = (await (await api("/api/services/svc/keys")).json()) as any;
  const startNow = Math.floor(Date.now() / 1000);
  const coolingBefore = beforeKeys.keys.filter((k: any) => k.cooldownUntil > startNow).length;

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
  assert.match(text, /rate limit exceeded/, "the upstream error should reach the client unchanged");
  assert.equal(seen.length, 1, "an unannotated tool must not be replayed");
  assert.equal(sideEffects, 1, "the tool ran exactly once");

  const afterKeys = (await (await api("/api/services/svc/keys")).json()) as any;
  const checkNow = Math.floor(Date.now() / 1000);
  const coolingAfter = afterKeys.keys.filter((k: any) => k.cooldownUntil > checkNow).length;
  assert.equal(coolingAfter, coolingBefore + 1, "the failing key was not cooled down");
});

test("replays when the transport rejects the key before execution", async () => {
  script = (n) =>
    n === 0
      ? { status: 401, headers: { "content-type": "application/json" }, body: '{"error":"Invalid API key"}' }
      : sse({ result: { content: [{ type: "text", text: "real answer" }] }, jsonrpc: "2.0", id: 9 });

  seen.length = 0;

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
  assert.equal(seen.length, 2, "a pre-execution 401 should be replayed");
  assert.notEqual(seen[0]!.apiKey, seen[1]!.apiKey, "replay reused the same key");
});

test("replays a body-level failure for a tool that declared itself read-only", async () => {
  // A client lists tools before calling one, so the proxy sees the annotation
  // first. This is the only path that lets a body-level failure replay.
  script = () =>
    sse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [{ name: "reader", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
      },
    });
  seen.length = 0;
  await fetch(base + "/svc/mcp", {
    method: "POST",
    headers: { "x-proxy-key": PROXY_KEY, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  script = (n) =>
    n === 0
      ? sse({
          result: { content: [{ type: "text", text: "rate limit exceeded" }], isError: true },
          jsonrpc: "2.0",
          id: 9,
        })
      : sse({ result: { content: [{ type: "text", text: "real answer" }] }, jsonrpc: "2.0", id: 9 });

  seen.length = 0;
  const res = await fetch(base + "/svc/mcp", {
    method: "POST",
    headers: {
      "x-proxy-key": PROXY_KEY,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "reader", arguments: {} } }),
  });

  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /real answer/);
  assert.equal(seen.length, 2, "a read-only tool should be replayed");
  assert.notEqual(seen[0]!.apiKey, seen[1]!.apiKey, "replay reused the same key");
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

  const before = (await (await api("/api/services/svc/keys")).json()) as any;
  const startNow = Math.floor(Date.now() / 1000);
  const previous = new Map<string, number>(before.keys.map((k: any) => [k.id, k.cooldownUntil]));

  await fetch(base + "/svc/mcp", {
    method: "POST",
    headers: { "x-proxy-key": PROXY_KEY, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
  });

  const keys = (await (await api("/api/services/svc/keys")).json()) as any;
  const now = Math.floor(Date.now() / 1000);
  // Only look at keys this request readjusted. Earlier tests leave their own
  // cool-downs behind and those say nothing about this 429.
  const cooled = keys.keys.filter(
    (k: any) => k.cooldownUntil > now && k.cooldownUntil !== previous.get(k.id)
  );
  assert.ok(cooled.length >= 1, "no key was cooled");
  assert.ok(seen.length >= 1, "request never reached the upstream");
  for (const k of cooled) {
    assert.ok(k.cooldownUntil - now >= 25, `cooldown too short: ${k.cooldownUntil - now}s`);
    assert.ok(k.cooldownUntil - now <= 35, `cooldown too long: ${k.cooldownUntil - now}s`);
  }
});

test("returns 404 for a legacy SSE transport path", async () => {
  // The pre-2025-03 HTTP+SSE transport used two endpoints. This proxy only
  // speaks Streamable HTTP, so those paths must not silently half-work.
  for (const p of ["/svc/sse", "/svc/message"]) {
    const res = await fetch(base + p, { headers: { "x-proxy-key": PROXY_KEY } });
    assert.equal(res.status, 404, `${p} should not be routed`);
    await res.text();
  }
});

test("passes protocol headers through untouched", async () => {
  // The proxy is transport-level: it forwards the client's declared protocol
  // version and the 2026 routing headers verbatim, leaving negotiation to the
  // upstream.
  //
  // The 429 test above cooled every key, so add a fresh one for this call.
  await api("/api/services/svc/keys", { keys: "key-header-probe-1" });
  script = () => sse({ jsonrpc: "2.0", id: 1, result: {} });
  seen.length = 0;

  await fetch(base + "/svc/mcp", {
    method: "POST",
    headers: {
      "x-proxy-key": PROXY_KEY,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": "session-abc",
      "mcp-protocol-version": "2025-11-25",
      "mcp-method": "tools/list",
      "mcp-name": "web_search_exa",
      "last-event-id": "42",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  const h = seen[0]!.headers;
  assert.equal(h["mcp-session-id"], "session-abc");
  assert.equal(h["mcp-protocol-version"], "2025-11-25");
  assert.equal(h["mcp-method"], "tools/list");
  assert.equal(h["mcp-name"], "web_search_exa");
  assert.equal(h["last-event-id"], "42");
  // The client's own proxy credential must never reach the upstream.
  assert.equal(h["x-proxy-key"], undefined);
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

/* ------------------------------------------------------------ affinity */

const AFFINITY_KEY = "01a1c63f-43f4-7738-9b87-51c319dc0394";

/** Call a tool through the proxy and report which key served it. */
async function callTool(serviceId: string, name: string, args: unknown) {
  const res = await fetch(`${base}/${serviceId}/mcp`, {
    method: "POST",
    headers: {
      "x-proxy-key": PROXY_KEY,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  return { status: res.status, keyId: res.headers.get("x-proxy-key-id"), attempts: res.headers.get("x-proxy-attempts"), text };
}

test("pins a follow-up call to the key that minted the resource", async () => {
  const save = await api("/api/services", {
    id: "aff",
    name: "Affinity",
    upstreamUrl,
    auth: { type: "header", name: "x-api-key" },
    affinity: { responseFields: ["id"], ttlSecs: 3600 },
  });
  assert.equal(save.status, 200);

  await api("/api/services/aff/keys", { keys: "aff-key-one-1\naff-key-two-2" });

  // A creating call returns a job id inside the text block. Flip the reply after
  // the first call so later calls answer as ordinary tools would; otherwise the
  // unrelated search below would re-bind the same id to a different key.
  let mintNext = true;
  script = () => {
    if (mintNext) {
      mintNext = false;
      return sse({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ id: AFFINITY_KEY, status: "scraping" }) }] },
      });
    }
    return sse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ordinary result" }] } });
  };

  const create = await callTool("aff", "crawl", { url: "https://example.com" });
  assert.ok(create.keyId, "no key reported on the creating call");
  const ownerKey = create.keyId;

  // Now push the pool toward the other key by making the owner look busy. Two
  // free calls are enough: ranking compares (uses+1)/weight.
  const other = (await (await api("/api/services/aff/keys")).json()) as any;
  const otherKey = other.keys.find((k: any) => k.id !== ownerKey).id;

  // A request that does not mention the id should go to the other key.
  const plain = await callTool("aff", "search", { query: "something unrelated" });
  assert.notEqual(plain.keyId, ownerKey, "stateless traffic should have moved off the owner key");

  // A request mentioning the id must go back to the owner.
  const followUp = await callTool("aff", "check_crawl_status", { id: AFFINITY_KEY });
  assert.equal(followUp.keyId, ownerKey, "a follow-up referencing the id must stay on its key");
  assert.equal(followUp.attempts, "1", "a pinned request should never rotate");

  // The panel reports the live binding count.
  const list = (await (await api("/api/services")).json()) as any;
  const svc = list.services.find((s: any) => s.id === "aff");
  assert.ok(svc.affinityStats.live >= 1, "binding not counted");

  await api("/api/services/aff", undefined, "DELETE");
});

test("an unusable pinned key yields an explicit error instead of a 404", async () => {
  await api("/api/services", {
    id: "aff2",
    name: "Affinity 2",
    upstreamUrl,
    auth: { type: "header", name: "x-api-key" },
    affinity: { responseFields: ["id"], ttlSecs: 3600 },
  });
  await api("/api/services/aff2/keys", { keys: "aff2-key-one\naff2-key-two" });

  script = () =>
    sse({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify({ id: AFFINITY_KEY }) }] },
    });
  const create = await callTool("aff2", "crawl", { url: "https://example.com" });
  const ownerKey = create.keyId!;

  // Make the script stop minting so the only binding is the one above.
  script = () => sse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } });

  // Kill the owner so the binding cannot be served.
  const res = await fetch(`${base}/api/services/aff2/keys/${ownerKey}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-proxy-key": PROXY_KEY },
    body: JSON.stringify({ status: "invalid" }),
  });
  assert.equal(res.status, 200);

  const followUp = await callTool("aff2", "check_crawl_status", { id: AFFINITY_KEY });
  assert.equal(followUp.status, 200, "the error should be a JSON-RPC error, not an HTTP one");
  // The proxy answers with plain application/json here, not an SSE stream.
  const payload = JSON.parse(followUp.text);
  assert.equal(payload.error.code, -32001);
  assert.match(payload.error.message, /invalid|cannot be reached/i);
  assert.equal(payload.error.data.reason, "invalid");
  // No upstream attempt was made at all: the binding could not be served, and
  // trying another key would have produced a misleading 404.
  assert.equal(followUp.attempts, "0");

  await api("/api/services/aff2", undefined, "DELETE");
});

test("a service without affinity never pins", async () => {
  const save = await api("/api/services", {
    id: "noaff",
    name: "No affinity",
    upstreamUrl,
    auth: { type: "header", name: "x-api-key" },
  });
  assert.equal(save.status, 200);
  await api("/api/services/noaff/keys", { keys: "noaff-key-one\nnoaff-key-two" });

  script = () =>
    sse({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify({ id: AFFINITY_KEY }) }] },
    });
  await callTool("noaff", "crawl", { url: "https://example.com" });

  const followUp = await callTool("noaff", "check_crawl_status", { id: AFFINITY_KEY });
  // With two keys and rotation, the second call lands on the other key. Nothing
  // is pinned because the service opted out.
  const list = (await (await api("/api/services")).json()) as any;
  const svc = list.services.find((s: any) => s.id === "noaff");
  assert.equal(svc.affinityStats, null);
  assert.ok(followUp.keyId);

  await api("/api/services/noaff", undefined, "DELETE");
});

test("rejects affinity with no fields", async () => {
  const res = await api("/api/services", {
    id: "badaff",
    upstreamUrl,
    affinity: { responseFields: [], ttlSecs: 60 },
  });
  assert.equal(res.status, 400);
});
