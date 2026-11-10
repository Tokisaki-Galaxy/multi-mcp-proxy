/**
 * Embedded single-file admin panel, served at GET /admin.
 *
 * The page is public because a browser cannot attach a custom header on
 * navigation. It then asks for the proxy key and keeps it in localStorage,
 * attaching it as `x-proxy-key` on every API call.
 */

const CSS = `
  :root {
    --bg: #0d1014;
    --panel: #151a21;
    --panel-2: #1b222b;
    --border: #252d38;
    --text: #d8dee7;
    --muted: #878f9d;
    --accent: #6d5cff;
    --ok: #35d39a;
    --warn: #f5b544;
    --bad: #f87171;
    --mono: ui-monospace, "Cascadia Code", Consolas, monospace;
    --shadow: none;
  }
  [data-theme="light"] {
    --bg: #f6f7f9;
    --panel: #ffffff;
    --panel-2: #f2f4f7;
    --border: #e2e6ec;
    --text: #1c2430;
    --muted: #67707e;
    --accent: #5b4bdb;
    --ok: #0a7a53;
    --warn: #a86700;
    --bad: #c72b2b;
    --mono: ui-monospace, "Cascadia Code", Consolas, monospace;
    --shadow: 0 1px 2px rgba(16, 24, 40, .04), 0 1px 3px rgba(16, 24, 40, .06);
  }
  * { box-sizing: border-box; }
  html { color-scheme: dark; }
  html[data-theme="light"] { color-scheme: light; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    transition: background .12s ease, color .12s ease;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 18px 80px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 26px; }
  h1 { font-size: 19px; margin: 0 0 4px; letter-spacing: .2px; }
  .sub { color: var(--muted); font-size: 12.5px; }
  .card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 16px; margin-bottom: 14px; box-shadow: var(--shadow);
  }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  label.field { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 170px; }
  label.field > span { font-size: 11.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
  input, select, textarea {
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 8px 10px; font-size: 13.5px; font-family: inherit; width: 100%;
  }
  textarea { font-family: var(--mono); font-size: 12.5px; resize: vertical; min-height: 96px; }
  input:focus, select:focus, textarea:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
  button {
    background: var(--accent); color: #fff; border: 0; border-radius: 6px;
    padding: 9px 14px; font-size: 13.5px; cursor: pointer; white-space: nowrap;
  }
  button:hover { filter: brightness(1.08); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); }
  button.danger { background: transparent; color: var(--bad); border: 1px solid var(--border); }
  button.sm { padding: 5px 9px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.8px; }
  th {
    text-align: left; color: var(--muted); font-weight: 600; padding: 8px;
    border-bottom: 1px solid var(--border); font-size: 11.5px;
    text-transform: uppercase; letter-spacing: .5px;
  }
  td.note { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td { padding: 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tr:last-child td { border-bottom: 0; }
  code { font-family: var(--mono); font-size: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; }
  .badge.active { background: rgba(53,211,154,.14); color: var(--ok); }
  .badge.cooling { background: rgba(245,181,68,.14); color: var(--warn); }
  .badge.exhausted, .badge.invalid { background: rgba(248,113,113,.14); color: var(--bad); }
  [data-theme="light"] .badge.active { background: rgba(15,138,95,.12); }
  [data-theme="light"] .badge.cooling { background: rgba(168,103,0,.12); }
  [data-theme="light"] .badge.exhausted, [data-theme="light"] .badge.invalid { background: rgba(199,43,43,.10); }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); text-align: center; padding: 22px 0; font-size: 13px; }
  .msg { font-size: 12.5px; margin-top: 10px; min-height: 17px; }
  .msg.ok { color: var(--ok); } .msg.err { color: var(--bad); }
  .hidden { display: none !important; }
  .svc-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .svc-title { font-weight: 600; font-size: 14px; }
  .svc-url { color: var(--muted); font-size: 12px; font-family: var(--mono); word-break: break-all; }
  .stats { display: flex; gap: 14px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
  .stats b { color: var(--text); font-weight: 600; }
  .divider { height: 1px; background: var(--border); margin: 14px 0; }
  .keys { margin-top: 12px; }
  .toolbar { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; flex-wrap: wrap; }
  .kbd { font-family: var(--mono); font-size: 11.5px; background: var(--panel-2); padding: 2px 6px; border-radius: 4px; }
  .warnbox { border-left: 3px solid var(--warn); background: rgba(245,181,68,.07); padding: 10px 12px; font-size: 12.5px; color: var(--muted); border-radius: 4px; }
  [data-theme="light"] .warnbox { background: rgba(168,103,0,.06); }
  .hint { color: var(--muted); font-size: 12px; margin-top: 6px; }
`;

const HTML = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>multi-mcp-proxy 控制台</title>
<script>
  // Resolve the theme before first paint so there is no flash.
  // Saved value is "auto", "light" or "dark"; missing means auto, which is the
  // default so the panel matches the operating system out of the box.
  (function () {
    var saved = null;
    try { saved = localStorage.getItem("mmp_theme"); } catch (e) {}
    var mode = saved === "light" || saved === "dark" || saved === "auto" ? saved : "auto";
    var prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    var resolved = mode === "auto" ? (prefersLight ? "light" : "dark") : mode;
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.setAttribute("data-theme-mode", mode);
  })();
</script>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>multi-mcp-proxy</h1>
      <div class="sub">多服务 MCP 透明反代与密钥池</div>
    </div>
    <div class="row" style="flex:0 0 auto">
      <button id="themeBtn" class="ghost" onclick="toggleTheme()" title="切换主题">跟随系统</button>
      <button id="logoutBtn" class="ghost hidden" onclick="logout()">注销</button>
    </div>
  </header>

  <div class="card" id="loginCard">
    <form class="row" onsubmit="login(); return false;">
      <label class="field" style="flex:3">
        <span>代理密钥 x-proxy-key</span>
        <input id="authInput" type="password" autocomplete="off" placeholder="粘贴部署时设置的 PROXY_KEY" />
      </label>
      <button style="align-self:flex-end">进入</button>
    </form>
    <div class="msg" id="loginMsg"></div>
  </div>

  <div id="app" class="hidden">
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div class="svc-title">新增服务</div>
        <select id="preset" style="width:auto" onchange="applyPreset()">
          <option value="">从预置选择…</option>
          <option value="tavily">Tavily</option>
          <option value="firecrawl">Firecrawl</option>
          <option value="exa">Exa</option>
          <option value="custom">自定义</option>
        </select>
      </div>
      <div class="divider"></div>
      <form onsubmit="addService(); return false;">
        <div class="row">
          <label class="field"><span>服务 ID</span><input id="f-id" placeholder="tavily" /></label>
          <label class="field"><span>显示名称</span><input id="f-name" placeholder="Tavily" /></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label class="field" style="flex:3"><span>上游 MCP 地址</span><input id="f-url" placeholder="https://mcp.tavily.com/mcp" /></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label class="field"><span>凭证位置</span>
            <select id="f-authType">
              <option value="header">请求头</option>
              <option value="query">URL 参数</option>
            </select>
          </label>
          <label class="field"><span>字段名</span><input id="f-authName" placeholder="x-api-key" /></label>
          <label class="field"><span>前缀</span><input id="f-authPrefix" placeholder="留空 或 Bearer " /></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label class="field"><span>额度耗尽状态码</span><input id="f-exhausted" placeholder="402,432,433" /></label>
          <label class="field"><span>限流状态码</span><input id="f-cooldown" placeholder="429" /></label>
          <label class="field"><span>失效状态码</span><input id="f-invalid" placeholder="401" /></label>
        </div>
        <div class="divider"></div>
        <div class="row">
          <div class="svc-title" style="flex:1">余额查询接口（可选）</div>
          <button type="button" class="ghost sm" onclick="toggleUsageFields()" id="usageToggleBtn">展开</button>
        </div>
        <div class="hint">上游有官方余额接口时填这里，面板的「同步余额」才能用。留空则该服务只能看密钥状态，看不到剩余额度。</div>
        <div id="usageFields" class="hidden">
          <div class="row" style="margin-top:10px">
            <label class="field" style="flex:3"><span>余额接口地址</span><input id="f-usageUrl" placeholder="https://api.firecrawl.dev/v2/team/credit-usage" /></label>
          </div>
          <div class="row" style="margin-top:10px">
            <label class="field"><span>认证头名称</span><input id="f-usageAuthName" placeholder="Authorization" /></label>
            <label class="field"><span>认证前缀</span><input id="f-usageAuthPrefix" placeholder="Bearer " /></label>
          </div>
          <div class="row" style="margin-top:10px">
            <label class="field"><span>已用字段路径</span><input id="f-usageUsed" placeholder="key.usage" /></label>
            <label class="field"><span>上限字段路径</span><input id="f-usageLimit" placeholder="key.limit" /></label>
            <label class="field"><span>剩余字段路径</span><input id="f-usageRemaining" placeholder="data.remainingCredits" /></label>
          </div>
          <div class="hint">路径用点号分隔，例如 <span class="kbd">data.remainingCredits</span>。填了「剩余字段」时，已用量由上限减剩余推出来。</div>
        </div>
        <div class="toolbar">
          <button type="submit">保存服务</button>
        </div>
        <div class="msg" id="svcMsg"></div>
      </form>
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div class="svc-title">服务列表</div>
        <button class="ghost sm" onclick="loadServices()">刷新</button>
      </div>
      <div class="divider"></div>
      <div id="svcList" class="empty">加载中…</div>
      <div class="msg" id="listMsg"></div>
    </div>

    <div class="card warnbox">
      客户端接入地址形如 <span class="kbd">https://你的域名/服务ID/mcp</span>，请求头带 <span class="kbd">x-proxy-key</span>。
    </div>
  </div>
</div>

<script>
const AUTH_STORE = "mmp_proxy_key";
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function setMsg(id, text, isErr) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.className = "msg " + (isErr ? "err" : "ok");
}

async function api(path, options) {
  const headers = Object.assign({}, (options && options.headers) || {}, {
    "x-proxy-key": localStorage.getItem(AUTH_STORE) || "",
  });
  if (options && options.body) headers["content-type"] = "application/json";
  const res = await fetch(path, Object.assign({}, options, { headers }));
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    logout();
    throw new Error("密钥无效");
  }
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

const THEME_MODES = ["auto", "light", "dark"];
const THEME_LABEL = { auto: "跟随系统", light: "浅色", dark: "深色" };

function prefersLight() {
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
}

function resolveTheme(mode) {
  return mode === "auto" ? (prefersLight() ? "light" : "dark") : mode;
}

function applyTheme(mode) {
  const root = document.documentElement;
  root.setAttribute("data-theme-mode", mode);
  root.setAttribute("data-theme", resolveTheme(mode));
  try { localStorage.setItem("mmp_theme", mode); } catch (e) {}
  syncThemeButton();
}

function currentMode() {
  const stored = document.documentElement.getAttribute("data-theme-mode");
  return THEME_MODES.includes(stored) ? stored : "auto";
}

function toggleTheme() {
  const mode = currentMode();
  applyTheme(THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length]);
}

function syncThemeButton() {
  const btn = $("themeBtn");
  if (!btn) return;
  const mode = currentMode();
  const resolved = resolveTheme(mode);
  btn.textContent = THEME_LABEL[mode];
  if (mode === "auto") {
    btn.title = "跟随系统（当前" + (resolved === "light" ? "浅色" : "深色") + "），点击切到浅色";
  } else if (mode === "light") {
    btn.title = "固定浅色，点击切到深色";
  } else {
    btn.title = "固定深色，点击切回跟随系统";
  }
}

/** Re-resolve when the OS flips while the page is open and the mode is auto. */
if (window.matchMedia) {
  const query = window.matchMedia("(prefers-color-scheme: light)");
  const onChange = () => {
    if (currentMode() === "auto") {
      document.documentElement.setAttribute("data-theme", resolveTheme("auto"));
      syncThemeButton();
    }
  };
  if (query.addEventListener) query.addEventListener("change", onChange);
  else if (query.addListener) query.addListener(onChange);
}
syncThemeButton();

function login() {
  const value = $("authInput").value.trim();
  if (!value) return;
  localStorage.setItem(AUTH_STORE, value);
  boot();
}

function logout() {
  localStorage.removeItem(AUTH_STORE);
  $("loginCard").classList.remove("hidden");
  $("app").classList.add("hidden");
  $("logoutBtn").classList.add("hidden");
  $("authInput").value = "";
  setMsg("loginMsg", "", false);
}

function boot() {
  $("loginCard").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("logoutBtn").classList.remove("hidden");
  loadServices();
}

const PRESETS = {
  tavily: {
    id: "tavily", name: "Tavily",
    url: "https://mcp.tavily.com/mcp",
    authType: "header", authName: "Authorization", authPrefix: "Bearer ",
    exhausted: "402,432,433", cooldown: "429", invalid: "401",
    usage: {
      url: "https://api.tavily.com/usage",
      authName: "Authorization", authPrefix: "Bearer ",
      used: "key.usage", limit: "key.limit", remaining: "",
    },
  },
  firecrawl: {
    id: "firecrawl", name: "Firecrawl",
    url: "https://mcp.firecrawl.dev/mcp",
    authType: "header", authName: "x-api-key", authPrefix: "",
    exhausted: "402", cooldown: "429", invalid: "401",
    usage: {
      url: "https://api.firecrawl.dev/v2/team/credit-usage",
      authName: "Authorization", authPrefix: "Bearer ",
      used: "", limit: "data.planCredits", remaining: "data.remainingCredits",
    },
  },
  exa: {
    id: "exa", name: "Exa",
    url: "https://mcp.exa.ai/mcp",
    authType: "header", authName: "x-api-key", authPrefix: "",
    exhausted: "402", cooldown: "429", invalid: "401",
    usage: null,
  },
};

/** Exa has no per-key balance endpoint on regular keys, only Team Management. */
const USAGE_PRESET_NOTE = {
  exa: "Exa 普通 API key 没有官方余额接口，只有开通 Team Management 后才有，因此这个服务的余额需要留空。",
};

function toggleUsageFields() {
  const box = $("usageFields");
  const btn = $("usageToggleBtn");
  const open = box.classList.contains("hidden");
  box.classList.toggle("hidden", !open);
  btn.textContent = open ? "收起" : "展开";
}

function fillUsage(u) {
  $("f-usageUrl").value = u ? u.url : "";
  $("f-usageAuthName").value = u ? u.authName : "";
  $("f-usageAuthPrefix").value = u ? u.authPrefix : "";
  $("f-usageUsed").value = u ? u.used : "";
  $("f-usageLimit").value = u ? u.limit : "";
  $("f-usageRemaining").value = u ? u.remaining : "";

  // Open the section when there is something to show, so preset users see it.
  if (u && $("usageFields").classList.contains("hidden")) toggleUsageFields();
}

function applyPreset() {
  const key = $("preset").value;
  if (!key) return;
  if (key === "custom") {
    ["f-id", "f-name", "f-url", "f-authPrefix"].forEach((id) => ($(id).value = ""));
    $("f-authType").value = "header";
    $("f-authName").value = "x-api-key";
    $("f-exhausted").value = "402,432,433";
    $("f-cooldown").value = "429";
    $("f-invalid").value = "401";
    fillUsage(null);
    setMsg("svcMsg", "", false);
    return;
  }
  const p = PRESETS[key];
  $("f-id").value = p.id;
  $("f-name").value = p.name;
  $("f-url").value = p.url;
  $("f-authType").value = p.authType;
  $("f-authName").value = p.authName;
  $("f-authPrefix").value = p.authPrefix;
  $("f-exhausted").value = p.exhausted;
  $("f-cooldown").value = p.cooldown;
  $("f-invalid").value = p.invalid;
  fillUsage(p.usage);
  setMsg("svcMsg", USAGE_PRESET_NOTE[key] || "", false);
}

function nums(str, fallback) {
  const out = String(str || "").split(/[,\\s]+/).map((v) => parseInt(v, 10)).filter((v) => Number.isFinite(v));
  return out.length ? out : fallback;
}

async function addService() {
  const usageUrl = $("f-usageUrl").value.trim();
  const usage = usageUrl
    ? {
        url: usageUrl,
        style: {
          type: "header",
          name: $("f-usageAuthName").value.trim() || "Authorization",
          prefix: $("f-usageAuthPrefix").value,
        },
        usedPath: $("f-usageUsed").value.trim() || undefined,
        limitPath: $("f-usageLimit").value.trim() || undefined,
        remainingPath: $("f-usageRemaining").value.trim() || undefined,
      }
    : undefined;

  const body = {
    id: $("f-id").value.trim().toLowerCase(),
    name: $("f-name").value.trim(),
    upstreamUrl: $("f-url").value.trim(),
    auth: {
      type: $("f-authType").value,
      name: $("f-authName").value.trim(),
      prefix: $("f-authPrefix").value,
    },
    quota: {
      exhaustedStatuses: nums($("f-exhausted").value, [402, 432, 433]),
      cooldownStatuses: nums($("f-cooldown").value, [429]),
      invalidStatuses: nums($("f-invalid").value, [401]),
      reset: "month",
      resetDay: 1,
    },
    usage,
  };
  try {
    await api("/api/services", { method: "POST", body: JSON.stringify(body) });
    setMsg("svcMsg", usage ? "已保存，带余额接口" : "已保存（无余额接口）", false);
    loadServices();
  } catch (e) {
    setMsg("svcMsg", e.message, true);
  }
}

function ago(secs) {
  if (!secs) return "-";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - secs);
  if (d < 60) return d + " 秒前";
  if (d < 3600) return Math.floor(d / 60) + " 分钟前";
  if (d < 86400) return Math.floor(d / 3600) + " 小时前";
  return Math.floor(d / 86400) + " 天前";
}

function quotaText(k) {
  if (k.quotaLimit == null) return '<span class="muted">未知</span>';
  const left = Math.max(0, (k.quotaLimit || 0) - (k.quotaUsed || 0));
  return '<code>' + left + '</code> / ' + k.quotaLimit;
}

function keyRows(serviceId, keys) {
  if (!keys.length) return '<div class="empty">还没有密钥</div>';
  let html = '<table><thead><tr><th>密钥</th><th>备注</th><th>状态</th><th>余额</th><th>权重</th><th>最后使用</th><th></th></tr></thead><tbody>';
  for (const k of keys) {
    html += "<tr>";
    html += "<td><code>" + esc(k.mask) + "</code></td>";
    html += '<td class="note">' + (k.label ? esc(k.label) : '<span class="muted">–</span>') + "</td>";
    html += '<td><span class="badge ' + esc(k.status) + '">' + esc(k.status) + "</span></td>";
    html += "<td>" + quotaText(k) + "</td>";
    html += "<td>" + esc(k.weight) + "</td>";
    html += '<td class="muted">' + ago(k.lastUsedAt) + "</td>";
    html += '<td style="text-align:right;white-space:nowrap">' +
      '<button class="ghost sm" data-act="edit-note" data-svc="' + esc(serviceId) + '" data-key="' + esc(k.id) + '" data-label="' + esc(k.label || "") + '">备注</button> ' +
      '<button class="danger sm" data-act="del-key" data-svc="' + esc(serviceId) + '" data-key="' + esc(k.id) + '">删除</button>' +
      "</td>";
    html += "</tr>";
  }
  return html + "</tbody></table>";
}

async function loadServices() {
  try {
    const data = await api("/api/services");
    const list = $("svcList");
    if (!data.services.length) {
      list.className = "empty";
      list.textContent = "还没有服务，先在上方新增一个。";
      return;
    }
    list.className = "";
    list.innerHTML = data.services.map((s) => {
      const st = s.stats || { total: 0, active: 0, cooling: 0, exhausted: 0, invalid: 0 };
      return '<div class="card" style="background:var(--panel-2);margin-bottom:12px">' +
        '<div class="svc-head">' +
          "<div>" +
            '<div class="svc-title">' + esc(s.name) + ' <span class="muted">/' + esc(s.id) + '/mcp</span></div>' +
            '<div class="svc-url">' + esc(s.upstreamUrl) + "</div>" +
          "</div>" +
          '<button class="danger sm" data-act="del-service" data-svc="' + esc(s.id) + '">删除服务</button>' +
        "</div>" +
        '<div class="stats" style="margin-top:10px">' +
          "<span>总数 <b>" + st.total + "</b></span>" +
          "<span>可用 <b>" + st.active + "</b></span>" +
          "<span>冷却 <b>" + st.cooling + "</b></span>" +
          "<span>耗尽 <b>" + st.exhausted + "</b></span>" +
          "<span>失效 <b>" + st.invalid + "</b></span>" +
        "</div>" +
        '<div class="divider"></div>' +
        '<div class="keys" id="keys-' + esc(s.id) + '"><div class="empty">加载中…</div></div>' +
        '<div class="row" style="margin-top:12px">' +
          '<textarea id="addkeys-' + esc(s.id) + '" placeholder="每行一个密钥。想加备注就在密钥后面跟一个逗号，例如：&#10;tvly-abc123,小号一号&#10;tvly-def456,备用"></textarea>' +
        "</div>" +
        '<div class="toolbar">' +
          '<button class="ghost sm" data-act="sync-keys" data-svc="' + esc(s.id) + '">同步余额</button>' +
          '<button class="sm" data-act="add-keys" data-svc="' + esc(s.id) + '">添加密钥</button>' +
        "</div>" +
        '<div class="msg" id="keymsg-' + esc(s.id) + '"></div>' +
      "</div>";
    }).join("");

    for (const s of data.services) loadKeys(s.id);
  } catch (e) {
    setMsg("listMsg", e.message, true);
  }
}

async function loadKeys(serviceId) {
  const host = $("keys-" + serviceId);
  if (!host) return;
  try {
    const data = await api("/api/services/" + encodeURIComponent(serviceId) + "/keys");
    host.innerHTML = keyRows(serviceId, data.keys || []);
  } catch (e) {
    host.innerHTML = '<div class="empty">读取失败：' + esc(e.message) + "</div>";
  }
}

async function addKeys(serviceId) {
  const box = $("addkeys-" + serviceId);
  const text = box.value.trim();
  if (!text) return setMsg("keymsg-" + serviceId, "请先粘贴密钥", true);
  try {
    const res = await api("/api/services/" + encodeURIComponent(serviceId) + "/keys", {
      method: "POST",
      body: JSON.stringify({ keys: text }),
    });
    box.value = "";
    setMsg("keymsg-" + serviceId, "新增 " + res.added + "，重复跳过 " + res.skipped, false);
    loadKeys(serviceId);
    loadServices();
  } catch (e) {
    setMsg("keymsg-" + serviceId, e.message, true);
  }
}

async function delKey(serviceId, keyId) {
  if (!confirm("确认删除这个密钥？")) return;
  try {
    await api("/api/services/" + encodeURIComponent(serviceId) + "/keys", {
      method: "DELETE",
      body: JSON.stringify({ ids: [keyId] }),
    });
    loadKeys(serviceId);
    loadServices();
  } catch (e) {
    setMsg("keymsg-" + serviceId, e.message, true);
  }
}

async function editNote(serviceId, keyId, current) {
  const next = prompt("备注（留空则清除）", current || "");
  if (next === null) return;
  try {
    await api("/api/services/" + encodeURIComponent(serviceId) + "/keys/" + encodeURIComponent(keyId), {
      method: "PATCH",
      body: JSON.stringify({ label: next.trim() }),
    });
    setMsg("keymsg-" + serviceId, "备注已更新", false);
    loadKeys(serviceId);
  } catch (e) {
    setMsg("keymsg-" + serviceId, e.message, true);
  }
}

async function syncKeys(serviceId) {
  try {
    const res = await api("/api/services/" + encodeURIComponent(serviceId) + "/keys/sync", { method: "POST" });
    setMsg("keymsg-" + serviceId, "同步 " + res.synced + "，失败 " + res.failed, false);
    loadKeys(serviceId);
  } catch (e) {
    setMsg("keymsg-" + serviceId, e.message, true);
  }
}

async function delService(serviceId) {
  if (!confirm("删除服务 " + serviceId + " 及其全部密钥？")) return;
  try {
    await api("/api/services/" + encodeURIComponent(serviceId), { method: "DELETE" });
    loadServices();
  } catch (e) {
    setMsg("listMsg", e.message, true);
  }
}

/* One delegated listener keeps every dynamically rendered button working
   without inline handlers, which would need quote escaping inside a template. */
document.addEventListener("click", function (ev) {
  const btn = ev.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.getAttribute("data-act");
  const svc = btn.getAttribute("data-svc") || "";
  if (act === "del-key") delKey(svc, btn.getAttribute("data-key") || "");
  else if (act === "del-service") delService(svc);
  else if (act === "sync-keys") syncKeys(svc);
  else if (act === "add-keys") addKeys(svc);
  else if (act === "edit-note") editNote(svc, btn.getAttribute("data-key") || "", btn.getAttribute("data-label") || "");
});

if (localStorage.getItem(AUTH_STORE)) boot();
</script>
</body>
</html>`;

export const ADMIN_HTML = HTML;
