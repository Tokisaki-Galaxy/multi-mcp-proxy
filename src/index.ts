import { Hono } from "hono";
import { forwardMCP } from "./forward";
import {
  listServices,
  getService,
  putService,
  deleteService,
  isValidServiceId,
} from "./registry";
import { renderAdmin } from "./admin-ui";
import { parseKeyInput } from "./key-input";
import { negotiate, t, isLocale, type LocaleCode, type MessageKey } from "./i18n";import { explicitLocale, langCookie, readCookie, LANG_COOKIE, LANG_QUERY } from "./i18n/locale";
import type { ServiceConfig, QuotaRules, AuthStyle, UsageProbe } from "./types";
import type { KeyPool } from "./pool";

export { KeyPool } from "./pool";

type Env = {
  KEY_POOL: DurableObjectNamespace<KeyPool>;
  REGISTRY: KVNamespace;
  PROXY_KEY?: string;
  ENCRYPTION_KEY?: string;
};

type Ctx = {
  req: {
    header: (n: string) => string | undefined;
    query: (n: string) => string | undefined;
  };
  env: Env;
};

const app = new Hono<{ Bindings: Env }>();

/**
 * Locale for this request.
 *
 * Explicit choice wins over the browser preference, so a shared link that pins
 * `?lang=ja` renders in Japanese for everyone who opens it.
 */
function localeOf(c: Ctx): LocaleCode {
  const explicit = explicitLocale(
    c.req.query(LANG_QUERY),
    readCookie(c.req.header("cookie"), LANG_COOKIE)
  );
  if (explicit) return explicit;
  return negotiate(c.req.header("accept-language"));
}

/** Localized JSON error. */
function fail(c: any, status: number, key: MessageKey, vars?: Record<string, string | number>) {
  return c.json({ error: t(localeOf(c), key, vars) }, status);
}

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
//
// Rendering happens server side so the first paint is already translated, and a
// language switch is a plain navigation rather than a client-side re-render.
// ---------------------------------------------------------------------------
app.get("/admin", (c) => {
  const locale = localeOf(c);
  const requested = c.req.query(LANG_QUERY);
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=UTF-8",
    // Content varies by language, so caches must key on it.
    vary: "Accept-Language, Cookie",
    "content-language": locale,
  };
  // Persist only a choice the user actually made, and only when the value was
  // one we support. Writing a cookie for a junk `?lang=` would poison the
  // preference until the user cleared it by hand.
  if (isLocale(requested)) headers["set-cookie"] = langCookie(locale);
  return new Response(renderAdmin(locale), { status: 200, headers });
});

// ---------------------------------------------------------------------------
// Auth guard for everything under /api and every /:service/mcp route.
// ---------------------------------------------------------------------------
app.use("/api/*", async (c, next) => {
  if (!authorized(c)) return fail(c, 401, "api.unauthorized");
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
  if (!body) return fail(c, 400, "api.invalidJson");

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
    return fail(c, 400, "api.urlHttps");
  }

  const existing = await getService(c.env.REGISTRY, id);
  const now = Math.floor(Date.now() / 1000);

  const auth: AuthStyle = body.auth && typeof body.auth === "object" ? (body.auth as AuthStyle) : DEFAULT_AUTH;
  if (auth.type !== "header" && auth.type !== "query") {
    return fail(c, 400, "api.authType");
  }
  if (!auth.name) return fail(c, 400, "api.authNameRequired");

  const quota: QuotaRules = { ...DEFAULT_QUOTA, ...(body.quota ?? {}) };

  // A usage probe is optional, but when present it must point somewhere https
  // and carry at least one readable path, otherwise "sync balance" silently
  // does nothing useful.
  let usage: UsageProbe | undefined;
  if (body.usage && typeof body.usage === "object") {
    const raw = body.usage as UsageProbe;
    const usageUrl = String(raw.url ?? "").trim();
    const probeHttps = /^https:\/\/[^\s]+$/.test(usageUrl);
    const probeLoopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(usageUrl);
    if (!probeHttps && !probeLoopback) {
      return fail(c, 400, "api.usageUrlHttps");
    }
    const style: AuthStyle = raw.style && typeof raw.style === "object" ? raw.style : auth;
    if (style.type !== "header" && style.type !== "query") {
      return fail(c, 400, "api.usageAuthType");
    }
    if (!style.name) return fail(c, 400, "api.usageAuthNameRequired");

    const usedPath = raw.usedPath ? String(raw.usedPath).trim() : undefined;
    const limitPath = raw.limitPath ? String(raw.limitPath).trim() : undefined;
    const limitFallbackPath = raw.limitFallbackPath ? String(raw.limitFallbackPath).trim() : undefined;
    const remainingPath = raw.remainingPath ? String(raw.remainingPath).trim() : undefined;
    if (!usedPath && !remainingPath) {
      return c.json(
        { error: "usage needs usedPath or remainingPath so the balance can be read" },
        400
      );
    }

    usage = { url: usageUrl, style, usedPath, limitPath, limitFallbackPath, remainingPath };
  }

  const service: ServiceConfig = {
    id,
    name: String(body.name ?? id),
    enabled: body.enabled !== false,
    upstreamUrl,
    auth,
    quota,
    usage,
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
  if (!removed) return fail(c, 404, "api.serviceNotFound");
  return c.json({ deleted: id });
});

// ---------------------------------------------------------------------------
// Keys per service
// ---------------------------------------------------------------------------
app.get("/api/services/:id/keys", async (c) => {
  const id = c.req.param("id");
  const service = await getService(c.env.REGISTRY, id);
  if (!service) return fail(c, 404, "api.serviceNotFound");
  const keys = await poolFor(c.env, id).listKeys();
  return c.json({ serviceId: id, keys: keys.map((k) => ({ ...k, serviceId: id })) });
});

app.post("/api/services/:id/keys", async (c) => {
  const id = c.req.param("id");
  const service = await getService(c.env.REGISTRY, id);
  if (!service) return fail(c, 404, "api.serviceNotFound");

  const body = await c.req.json<{ keys?: unknown; weight?: number }>().catch(() => null);
  if (!body) return fail(c, 400, "api.invalidJson");

  const keys = parseKeyInput(body.keys);
  if (keys.length === 0) return fail(c, 400, "api.noKeys");

  // A label may repeat across different secrets, but not within one batch: a
  // duplicated label would make the panel unreadable without telling anyone.
  const seenLabels = new Set<string>();
  for (const entry of keys) {
    if (!entry.label) continue;
    const key = entry.label.toLowerCase();
    if (seenLabels.has(key)) {
      return fail(c, 400, "api.duplicateNote", { label: entry.label });
    }
    seenLabels.add(key);
  }

  const weight = Number.isFinite(body.weight) ? Math.max(1, Math.min(100, Number(body.weight))) : 1;
  const result = await poolFor(c.env, id).addKeys(keys, weight);
  return c.json(result);
});

app.delete("/api/services/:id/keys", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.ids)) return fail(c, 400, "api.idsRequired");
  const removed = await poolFor(c.env, id).deleteKeys(body.ids.map(String));
  return c.json({ deleted: removed });
});

app.patch("/api/services/:id/keys/:keyId", async (c) => {
  const id = c.req.param("id");
  const keyId = c.req.param("keyId");
  const body = await c.req.json<{ weight?: number; status?: string; label?: string }>().catch(() => null);
  if (!body) return fail(c, 400, "api.invalidJson");
  const ok = await poolFor(c.env, id).patchKey(keyId, body);
  if (!ok) return fail(c, 404, "api.keyNotFound");
  return c.json({ updated: keyId });
});

app.post("/api/services/:id/keys/sync", async (c) => {
  const id = c.req.param("id");
  const service = await getService(c.env.REGISTRY, id);
  if (!service) return fail(c, 404, "api.serviceNotFound");
  if (!service.usage) {
    return fail(c, 400, "api.noUsageProbe", { id });
  }
  const result = await poolFor(c.env, id).syncUsage(service.usage);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// The proxy itself. Every method is forwarded: POST for JSON-RPC, GET for
// server-initiated streams, DELETE for session termination.
//
// Errors on this route stay in English on purpose. The consumer is an MCP client
// or an integration, never a human reading the panel, and MCP error payloads are
// conventionally English. Translating them would grow the catalogs and give no
// benefit to the calling model.
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

app.notFound((c) => fail(c, 404, "api.notFound"));

app.onError((err, c) => {
  console.error("[multi-mcp-proxy]", err);
  return fail(c, 500, "api.internal");
});

export default app;
