/**
 * English message catalog. This file is the source of truth for message keys:
 * every other locale is typed against `MessageKey`, so a missing translation is
 * a compile error rather than a silent fallback at runtime.
 *
 * Conventions:
 *   - Keys are dotted, grouped by UI region.
 *   - `{placeholder}` is interpolated by `format`.
 *   - Pluralized messages carry `.one` / `.other` suffixes and are resolved
 *     through `Intl.PluralRules`, never by string concatenation.
 *   - Text is plain, no HTML. The renderer escapes everything it injects.
 */

export const en = {
  // ---------------------------------------------------------------- generic
  "app.subtitle": "Multi-service transparent MCP proxy with key pools",
  "action.refresh": "Refresh",
  "action.delete": "Delete",
  "action.logout": "Log out",
  "state.loading": "Loading…",
  "state.unknown": "unknown",

  // ------------------------------------------------------------------ theme
  "theme.mode.auto": "System",
  "theme.mode.light": "Light",
  "theme.mode.dark": "Dark",
  "theme.title.auto": "Following the system, currently {resolved}. Click for light.",
  "theme.title.light": "Pinned to light. Click for dark.",
  "theme.title.dark": "Pinned to dark. Click to follow the system.",
  "theme.resolved.light": "light",
  "theme.resolved.dark": "dark",

  // --------------------------------------------------------------- language
  "lang.label": "Language",

  // ------------------------------------------------------------------ login
  "login.field": "Proxy key (x-proxy-key)",
  "login.placeholder": "Paste the PROXY_KEY set at deploy time",
  "login.submit": "Enter",
  "login.invalid": "That key was rejected",

  // ----------------------------------------------------------- service form
  "svc.new": "Add a service",
  "svc.preset.none": "Start from a preset",
  "svc.preset.custom": "Custom",
  "svc.field.id": "Service ID",
  "svc.field.name": "Display name",
  "svc.field.url": "Upstream MCP endpoint",
  "svc.field.authType": "Credential location",
  "svc.field.authType.header": "Request header",
  "svc.field.authType.query": "URL parameter",
  "svc.field.authName": "Field name",
  "svc.field.authPrefix": "Prefix",
  "svc.field.authPrefixHint": "Empty, or Bearer ",
  "svc.field.exhausted": "Quota-exhausted statuses",
  "svc.field.cooldown": "Rate-limit statuses",
  "svc.field.invalid": "Invalid-key statuses",
  "svc.save": "Save service",
  "svc.saved": "Saved",
  "svc.savedWithUsage": "Saved, with a balance endpoint",
  "svc.savedWithoutUsage": "Saved, no balance endpoint",

  // -------------------------------------------------------------- usage api
  "usage.title": "Balance endpoint (optional)",
  "usage.expand": "Expand",
  "usage.collapse": "Collapse",
  "usage.hint":
    "Fill this in when the upstream exposes a balance API. Without it the panel shows key state but not remaining quota.",
  "usage.field.url": "Balance endpoint",
  "usage.field.authName": "Auth header name",
  "usage.field.authPrefix": "Auth prefix",
  "usage.field.used": "Used path",
  "usage.field.limit": "Limit path",
  "usage.field.limitFallback": "Limit fallback path",
  "usage.field.remaining": "Remaining path",
  "usage.hint.paths":
    "Paths are dot separated, for example data.remainingCredits. A null limit falls through to the fallback path, which Tavily needs because its key.limit is often null. When a remaining path is set, used is derived from limit minus remaining.",
  "usage.presetNote.exa":
    "Regular Exa API keys have no balance endpoint; it requires Team Management. Leave the balance fields empty for this service.",

  // ----------------------------------------------------------- service list
  "svc.list": "Services",
  "svc.empty": "No services yet. Add one above.",
  "svc.delete": "Delete service",
  "svc.deleteConfirm": "Delete service {id} and all of its keys?",
  "svc.stats.total": "total",
  "svc.stats.active": "available",
  "svc.stats.cooling": "cooling",
  "svc.stats.exhausted": "exhausted",
  "svc.stats.invalid": "invalid",

  // ------------------------------------------------------------------- keys
  "keys.empty": "No keys yet",
  "keys.col.key": "Key",
  "keys.col.note": "Note",
  "keys.col.status": "Status",
  "keys.col.quota": "Balance",
  "keys.col.weight": "Weight",
  "keys.col.lastUsed": "Last used",
  "keys.add": "Add keys",
  "keys.sync": "Sync balance",
  "keys.placeholder":
    "One key per line. Add a note after a comma:\ntvly-abc123,main account\ntvly-def456,spare",
  "keys.note": "Note",
  "keys.notePrompt": "Note. Leave empty to clear it.",
  "keys.noteUpdated": "Note updated",
  "keys.deleteConfirm": "Delete this key?",
  "keys.pasteFirst": "Paste at least one key first",
  "keys.added": "Added {added}, skipped {skipped} duplicates",
  "keys.synced": "Synced {synced}, failed {failed}",
  "keys.readFailed": "Could not load: {message}",
  "keys.status.active": "active",
  "keys.status.cooling": "cooling",
  "keys.status.exhausted": "exhausted",
  "keys.status.invalid": "invalid",
  "keys.ago.seconds.one": "{n} second ago",
  "keys.ago.seconds.other": "{n} seconds ago",
  "keys.ago.minutes.one": "{n} minute ago",
  "keys.ago.minutes.other": "{n} minutes ago",
  "keys.ago.hours.one": "{n} hour ago",
  "keys.ago.hours.other": "{n} hours ago",
  "keys.ago.days.one": "{n} day ago",
  "keys.ago.days.other": "{n} days ago",

  // ---------------------------------------------------------------- notices
  "notice.endpoint":
    "Clients connect to https://your-domain/{service}/mcp and send the x-proxy-key header.",

  // ------------------------------------------------------------- api errors
  "api.unauthorized": "Unauthorized",
  "api.invalidJson": "Invalid JSON body",
  "api.badId": "Invalid id. Use lowercase letters, digits, dash or underscore, 1 to 32 chars, not a reserved word.",
  "api.urlHttps": "upstreamUrl must be an https URL",
  "api.authType": "auth.type must be 'header' or 'query'",
  "api.authNameRequired": "auth.name is required",
  "api.usageUrlHttps": "usage.url must be an https URL",
  "api.usageAuthType": "usage.style.type must be 'header' or 'query'",
  "api.usageAuthNameRequired": "usage.style.name is required",
  "api.usageNeedsPath": "usage needs usedPath or remainingPath so the balance can be read",
  "api.serviceNotFound": "Service not found",
  "api.noKeys": "No keys provided",
  "api.duplicateNote": "Duplicated note in this batch: {label}",
  "api.idsRequired": "Body must be { ids: string[] }",
  "api.keyNotFound": "Key not found",
  "api.notFound": "Not found",
  "api.internal": "Internal proxy error",
  "api.noUsageProbe":
    "Service {id} has no balance endpoint configured, so balances cannot be synced. Fill in the balance endpoint above. Regular Exa API keys have no balance API; it requires Team Management.",
};

export type MessageKey = keyof typeof en;
export type Catalog = Record<MessageKey, string>;
