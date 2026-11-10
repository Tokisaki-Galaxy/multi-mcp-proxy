import { Hono } from "hono";
import { forwardMCP } from "./forward";
import {
  listServices,
  getService,
  putService,
  deleteService,
  isValidServiceId,
} from "./registry";
import { ADMIN_HTML } from "./admin-ui";
import type { ServiceConfig, QuotaRules, AuthStyle, UsageProbe } from "./types";
import type { KeyPool } from "./pool";

export { KeyPool } from "./pool";

type Env = {
  KEY_POOL: DurableObjectNamespace<KeyPool>;
  REGISTRY: KVNamespace;
  PROXY_KEY?: string;
  ENCRYPTION_KEY?: string;
};

const app = new Hono<{ Bindings: Env }>();

/** Constant-time-ish comparison for the proxy credential. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(c: { req: { header: (n: string) => string | undefined }; env: Env }): boolean {
  const expected = c.env.PROXY_KEY;
  if (!expected) return false;
  const provided = c.req.header("x-proxy-key");
  if (!provided) return false;
  return safeEqual(provided, expected);
}

const DEFAULT_QUOTA: QuotaRules = {
  exhaustedStatuses: [402, 432, 433],
  cooldownStatuses: [429],
  invalidStatuses: [401],
  reset: "month",
  resetDay: 1,
};

const DEFAULT_AUTH: AuthStyle = { type: "header", name: "x-api-key" };

function poolFor(env: Env, serviceId: string) {
  const id = env.KEY_POOL.idFromName(serviceId);
  return env.KEY_POOL.get(id);
}

// ---------------------------------------------------------------------------
// Public: health
// ---------------------------------------------------------------------------
app.get("/", (c) =>
  c.json({
    service: "multi-mcp-proxy",
    version: "0.1.0",
    endpoints: {
      mcp: "ANY /:service/mcp",
      admin: "GET /admin",
      services: "GET|POST|DELETE /api/services",
      keys: "GET|POST|DELETE /api/services/:id/keys",
    },
  })
);

// ---------------------------------------------------------------------------
// Public: admin page. It is a static shell that asks for the proxy key, because
// a browser cannot attach a custom header on navigation.
// ---------------------------------------------------------------------------
app.get("/admin", (c) => c.html(ADMIN_HTML));

// ---------------------------------------------------------------------------
// Auth guard for everything under /api and every /:service/mcp route.
// ---------------------------------------------------------------------------
app.use("/api/*", async (c, next) => {
  if (!authorized(c)) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// ---------------------------------------------------------------------------
// Services CRUD
// ---------------------------------------------------------------------------
app.get("/api/services", async (c) => {
  const services = await listServices(c.env.REGISTRY);
  const enriched = await Promise.all(
    services.map(async (s) => {
      const stats = await poolFor(c.env, s.id).stats();
      return { ...s, stats };
    })
  );
  return c.json({ services: enriched });
});

app.post("/api/services", async (c) => {
  const body = await c.req.json<Partial<ServiceConfig>>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const id = String(body.id ?? "").trim().toLowerCase();
  if (!isValidServiceId(id)) {
    return c.json(
      { error: "Invalid id. Use lowercase letters, digits, dash or underscore, 1-32 chars, not reserved." },
      400
    );
  }

  const upstreamUrl = String(body.upstreamUrl ?? "").trim();
  // https everywhere, with a loopback exception so the integration test can
  // point at a local stand-in upstream.
  const isHttps = /^https:\/\/[^\s]+$/.test(upstreamUrl);
  const isLoopbackHttp = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(upstreamUrl);
  if (!isHttps && !isLoopbackHttp) {
    return c.json({ error: "upstreamUrl must be an https URL" }, 400);
  }

  const existing = await getService(c.env.REGISTRY, id);
  const now = Math.floor(Date.now() / 1000);

  const auth: AuthStyle = body.auth && typeof body.auth === "object" ? (body.auth as AuthStyle) : DEFAULT_AUTH;
  if (auth.type !== "header" && auth.type !== "query") {
    return c.json({ error: "auth.type must be 'header' or 'query'" }, 400);
  }
  if (!auth.name) return c.json({ error: "auth.name is required" }, 400);

  const quota: QuotaRules = { ...DEFAULT_QUOTA, ...(body.quota ?? {}) };

  const service: ServiceConfig = {
    id,
    name: String(body.name ?? id),
    enabled: body.enabled !== false,
    upstreamUrl,
    auth,
    quota,
    usage: (body.usage as UsageProbe | undefined) ?? undefined,
    retryOn5xx: body.retryOn5xx === true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await putService(c.env.REGISTRY, service);
  return c.json({ service });
});

app.delete("/api/services/:id", async (c) => {
  const id = c.req.param("id");
  const removed = await deleteService(c.env.REGISTRY, id);
  if (!removed) return c.json({ error: "Service not found" }, 404);
  return c.json({ deleted: id });
});

// ---------------------------------------------------------------------------
// Keys per service
// ---------------------------------------------------------------------------
app.get("/api/services/:id/keys", async (c) => {
  const id = c.req.param("id");
  const service = await getService(c.env.REGISTRY, id);
  if (!service) return c.json({ error: "Service not found" }, 404);
  const keys = await poolFor(c.env, id).listKeys();
  return c.json({ serviceId: id, keys: keys.map((k) => ({ ...k, serviceId: id })) });
});

app.post("/api/services/:id/keys", async (c) => {
  const id = c.req.param("id");
  const service = await getService(c.env.REGISTRY, id);
  if (!service) return c.json({ error: "Service not found" }, 404);

  const body = await c.req.json<{ keys?: unknown; weight?: number }>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  // Accept either a string (one per line, so pasting a column of keys works)
  // or an array of strings.
  const rawList: string[] = Array.isArray(body.keys)
    ? body.keys.map(String)
    : typeof body.keys === "string"
      ? body.keys.split(/[\r\n,]+/)
      : [];

  const keys = rawList
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .map((secret) => ({ secret }));

  if (keys.length === 0) return c.json({ error: "No keys provided" }, 400);

  const weight = Number.isFinite(body.weight) ? Math.max(1, Math.min(100, Number(body.weight))) : 1;
  const result = await poolFor(c.env, id).addKeys(keys, weight);
  return c.json(result);
});

app.delete("/api/services/:id/keys", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.ids)) return c.json({ error: "Body must be { ids: string[] }" }, 400);
  const removed = await poolFor(c.env, id).deleteKeys(body.ids.map(String));
  return c.json({ deleted: removed });
});

app.patch("/api/services/:id/keys/:keyId", async (c) => {
  const id = c.req.param("id");
  const keyId = c.req.param("keyId");
  const body = await c.req.json<{ weight?: number; status?: string; label?: string }>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const ok = await poolFor(c.env, id).patchKey(keyId, body);
  if (!ok) return c.json({ error: "Key not found" }, 404);
  return c.json({ updated: keyId });
});

app.post("/api/services/:id/keys/sync", async (c) => {
  const id = c.req.param("id");
  const service = await getService(c.env.REGISTRY, id);
  if (!service) return c.json({ error: "Service not found" }, 404);
  if (!service.usage) return c.json({ error: "This service has no usage probe configured" }, 400);
  const result = await poolFor(c.env, id).syncUsage(service.usage);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// The proxy itself. Every method is forwarded: POST for JSON-RPC, GET for
// server-initiated streams, DELETE for session termination.
// ---------------------------------------------------------------------------
app.all("/:service/mcp", async (c) => {
  if (!authorized(c)) return c.json({ error: "Unauthorized" }, 401);

  const serviceId = c.req.param("service");
  const service = await getService(c.env.REGISTRY, serviceId);
  if (!service) return c.json({ error: `Unknown service '${serviceId}'` }, 404);
  if (!service.enabled) return c.json({ error: `Service '${serviceId}' is disabled` }, 503);

  const pool = poolFor(c.env, serviceId);
  const outcome = await forwardMCP(c.req.raw, service, pool);

  const headers = new Headers(outcome.response.headers);
  headers.set("x-proxy-attempts", String(outcome.attempts));
  if (outcome.keyId) headers.set("x-proxy-key-id", outcome.keyId);

  return new Response(outcome.response.body, {
    status: outcome.response.status,
    statusText: outcome.response.statusText,
    headers,
  });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  console.error("[multi-mcp-proxy]", err);
  return c.json({ error: "Internal proxy error" }, 500);
});

export default app;
