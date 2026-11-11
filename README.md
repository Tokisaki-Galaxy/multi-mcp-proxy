<div align="center">

# multi-mcp-proxy

**A transparent MCP reverse proxy for Cloudflare Workers, with one API key pool per service.**

Point a request at a service, and it goes to the upstream MCP endpoint byte for byte. The proxy replaces one header, the credential. When the upstream says a key is dead, the proxy swaps in the next one and replays the request. The client never notices.

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Durable Objects](https://img.shields.io/badge/Durable%20Objects-SQLite-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/durable-objects/)
[![Hono](https://img.shields.io/badge/Hono-E36002?style=flat-square&logo=hono&logoColor=white)](https://hono.dev/)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-000000?style=flat-square)](https://modelcontextprotocol.io/)

[![Free plan](https://img.shields.io/badge/runs%20on-Workers%20Free-f0a020?style=flat-square)](https://developers.cloudflare.com/workers/platform/limits/)
[![Tests](https://img.shields.io/badge/tests-175%20passing-2ea44f?style=flat-square)](#development)
[![i18n](https://img.shields.io/badge/panel%20languages-5-6d5cff?style=flat-square)](#interface-languages)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[English](README.md) · [简体中文](README.zh.md)

</div>

---

## Why this exists

Hosted MCP endpoints report quota exhaustion and dead credentials inside an HTTP 200 response body:

```
event: message
data: {"result":{"content":[{"type":"text","text":"The Firecrawl API key is invalid or revoked."}],"isError":true},"jsonrpc":"2.0","id":9}
```

The status code is 200. A proxy that only looks at headers sees nothing wrong. So a dead key keeps receiving traffic forever, the client gets error text, and the proxy has no idea.

This project peeks at the first SSE event on the response stream. If it is a failure, the proxy discards the response and, when the failure proves nothing ran, picks another key and replays the same request body. If it is fine, the bytes already read are flushed back out and the rest streams through untouched.

## Measured, not assumed

The design came from probing each upstream by hand before writing any of it:

| Upstream | Endpoint | Credential | Exhaustion signal | Session bound to key |
|---|---|---|---|---|
| Tavily | `mcp.tavily.com/mcp` | `Authorization: Bearer` only | 432 and 200 body | no |
| Firecrawl | `mcp.firecrawl.dev/mcp` | `x-api-key` or Bearer | 200 body, `isError` | no |
| Exa | `mcp.exa.ai/mcp` | `x-api-key`, Bearer, or query param | 200 body, `isError` | no |

Three findings that shaped the architecture:

1. **Sessions are not bound to keys.** A session created with key A works fine when the next request arrives with key B, and the upstream bills B. So rotating keys never requires re-establishing a session.
2. **`initialize` and `tools/list` do not check quota.** Pooling only has to happen on `tools/call`.
3. **Firecrawl and Exa require `Accept` to list both `application/json` and `text/event-stream`.** Miss either and you get a flat 406.

## Architecture

```
client ── x-proxy-key ──► Worker
                           │
                           ├─ KV              service registry
                           │                  read hot path, written by admin only
                           │
                           └─ Durable Object  one per service
                                └─ SQLite     key pool, serialized so picks are atomic
```

State lives in a Durable Object's SQLite rather than KV because the KV free tier allows 1000 writes and 1000 list operations per day. Any KV-backed pool that lists and writes on every request dies somewhere under 500 calls a day. Durable Objects on the free plan allow 100k row writes and 5M row reads per day, which is enough.

Key selection prefers the least loaded, ranking by `(uses + 1) / weight` ascending and breaking ties on last-used time. A key with a higher weight reaches the same ratio only after proportionally more traffic, so load spreads in proportion to weight instead of pinning one key.

Credentials are encrypted with AES-GCM before storage. The data key comes from a Worker secret. The list API only ever returns a mask.

## Interface languages

The admin panel ships in English, Simplified Chinese, Japanese, German and French. It picks a language from `Accept-Language`, and you can override it with the picker or `?lang=ja`.

Rendering happens server side, so the first paint is already in the right language with no flash. The choice persists in a cookie. Adding a language means adding one file under `src/i18n/`; the `Catalog` type forces you to cover every key, so a missing translation is a compile error rather than a silent English fallback.

The MCP endpoints themselves are not localized on purpose. Those errors are consumed by MCP clients and integrations, not by a human reading the panel, and MCP error payloads are conventionally English.

## Quick start

A Cloudflare account on the free plan is enough. This repository ships bound to a live KV namespace, so connecting it through the Cloudflare Git integration works as-is. Forking onto your own account? Replace the KV id in `wrangler.toml` with one you create.

```bash
pnpm install

# 1. Create the KV namespace, then put the id into wrangler.toml
npx wrangler kv namespace create REGISTRY

# 2. Set two secrets
npx wrangler secret put PROXY_KEY        # authenticates clients to the proxy
npx wrangler secret put ENCRYPTION_KEY   # encrypts the key pool, any 32+ byte string

# 3. Deploy
pnpm deploy
```

Then open `https://your-domain/admin` and log in with `PROXY_KEY`.

When adding a service you can start from the Tavily, Firecrawl or Exa preset, which fills in the credential location and the right status codes. For anything else, supply a service id, the upstream URL, and the credential field name.

Paste keys one per line to import them in bulk. To attach a note, follow the key with a comma:

```
tvly-abc123,main-account
tvly-def456,spare
tvly-ghi789
```

Notes are for humans only and are never sent upstream. Each row in the panel has a note button that edits or clears it.

## Client setup

```
https://your-domain/SERVICE_ID/mcp
```

Send the `x-proxy-key` header. For opencode:

```jsonc
{
  "mcp": {
    "servers": {
      "tavily": {
        "type": "remote",
        "url": "https://your-domain/tavily/mcp",
        "headers": { "x-proxy-key": "YOUR_PROXY_KEY" }
      }
    }
  }
}
```

## Routes

| Method | Path | Description |
|---|---|---|
| ANY | `/:service/mcp` | Transparent forward to that service's upstream |
| GET | `/admin` | Admin panel |
| GET | `/api/services` | Services with per-service key stats |
| POST | `/api/services` | Create or update a service |
| DELETE | `/api/services/:id` | Delete a service and its keys |
| GET | `/api/services/:id/keys` | List keys, masks only |
| POST | `/api/services/:id/keys` | Bulk add, one per line, optional `key,note` |
| PATCH | `/api/services/:id/keys/:keyId` | Change weight, status or note |
| DELETE | `/api/services/:id/keys` | Bulk delete |
| POST | `/api/services/:id/keys/sync` | Pull real balances from the upstream |

Everything except `/` and `/admin` requires `x-proxy-key`.

## Failure classification

Three layers, always in this order:

1. **HTTP status.** A configured invalid, exhausted or rate-limited status settles it immediately. Tavily's 432 and 433 both mean exhausted.
2. **JSON-RPC error envelope.** A top-level `error` object is classified by its message.
3. **Result object.** Text matching only runs when `result.isError` is true or an explicit error envelope is present. This layer exists so a search hit that happens to contain the word "unauthorized" in its title can never retire a key.

Replay is bounded by what the upstream actually told us:

- An auth, quota or rate-limit status on the HTTP status line is replayed. The transport refused the request, so nothing ran and nothing was billed.
- The same failure wrapped in an HTTP 200 body only replays for a request that is safe to repeat: a protocol method that cannot have side effects, or a tool that declared `readOnlyHint` or `idempotentHint`. The body reports that execution failed, not that nothing ran, and cancelling the response stream does not undo an upstream job.
- Annotations are picked up from the `tools/list` responses the proxy already forwards, so a client that lists tools before calling them is covered, and no extra upstream call is spent. A tool the proxy has never seen, or one listed without annotations, is treated as unsafe.
- 5xx and network errors are not replayed by default, because nothing proves the upstream did not start. A service can opt in with `retryOn5xx`.
- Non-idempotent tools such as research jobs stop being replayable once a job id comes back.

## Known limits

First-event peeking only covers synchronous tools. If a tool emits a progress notification before the real result, the first frame carries no verdict, so the request streams through without replay. That is deliberate: covering it means buffering the whole response, which costs you streaming.

Upstreams that wrap errors in result prose rather than `isError` need a per-service rule added.

Rotating free accounts to exceed a free tier violates most providers' terms, and mass account bans are a normal outcome. The pool survives a wide failure, but it does not prevent one.

## Development

```bash
pnpm dev          # local server
pnpm typecheck    # type check
pnpm test         # unit and Miniflare integration tests
pnpm e2e          # hit a real Exa endpoint to verify key rotation
pnpm check:ui     # syntax check the panel's inline scripts
```

Tests run on Node's built in runner, so vitest is not needed. `pnpm test` covers 175 cases. The integration suite boots Miniflare with a real KV binding and a SQLite Durable Object, and also checks locale negotiation, cookie precedence and catalog completeness.

Classification lives in `src/classify.ts`, forwarding and replay in `src/forward.ts`, the key pool in `src/pool.ts`.

## License

MIT
