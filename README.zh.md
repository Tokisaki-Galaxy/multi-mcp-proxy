<div align="center">

# multi-mcp-proxy

**部署在 Cloudflare Workers 上的多服务 MCP 透明反向代理，每个服务一套独立的 API 密钥池。**

指向某个服务的请求会原样转发到上游 MCP 端点，代理只替换凭证那一行请求头。上游判定某把密钥额度耗尽或已失效时，代理自动换下一把重放同一份请求体，客户端无感知。

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Durable Objects](https://img.shields.io/badge/Durable%20Objects-SQLite-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/durable-objects/)
[![Hono](https://img.shields.io/badge/Hono-E36002?style=flat-square&logo=hono&logoColor=white)](https://hono.dev/)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-000000?style=flat-square)](https://modelcontextprotocol.io/)

[![免费版可跑](https://img.shields.io/badge/runs%20on-Workers%20Free-f0a020?style=flat-square)](https://developers.cloudflare.com/workers/platform/limits/)
[![测试](https://img.shields.io/badge/tests-175%20passing-2ea44f?style=flat-square)](#开发)
[![多语言](https://img.shields.io/badge/panel%20languages-5-6d5cff?style=flat-square)](#界面语言)
[![许可](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[English](README.md) · [简体中文](README.zh.md)

</div>

---

## 为什么需要它

主流 MCP 托管端点把额度耗尽和鉴权失败都塞进 HTTP 200 的响应体里：

```
event: message
data: {"result":{"content":[{"type":"text","text":"The Firecrawl API key is invalid or revoked."}],"isError":true},"jsonrpc":"2.0","id":9}
```

状态码是 200，纯 header 层的反代看不到任何异常。结果就是一把密钥失效后，所有请求都会继续打在它上面，客户端拿到的是错误文本，代理毫不知情。

这个项目在响应流上做一次首事件窥探。判定为失败就丢弃这次响应，确认失败发生在上游开工之前时，换一把密钥重放同一份请求体。判定正常就把已读字节补发回去，剩下的流原样转发。

## 实测依据

设计不是照文档写的，动手前对三个上游逐个探过：

| 上游 | 端点 | 凭证方式 | 无额度信号 | 会话绑定密钥 |
|---|---|---|---|---|
| Tavily | `mcp.tavily.com/mcp` | 仅 `Authorization: Bearer` | 432 与 200 正文 | 否 |
| Firecrawl | `mcp.firecrawl.dev/mcp` | `x-api-key` 或 Bearer | 200 正文 isError | 否 |
| Exa | `mcp.exa.ai/mcp` | `x-api-key`、Bearer 或 URL 参数 | 200 正文 isError | 否 |

三条决定架构的发现：

1. **会话不绑定密钥。** 用 A 建的会话，换 B 调用，上游用的是 B，扣费也记在 B 上。所以换密钥不需要重建会话。
2. **`initialize` 和 `tools/list` 不校验额度。** 池化只需要发生在 `tools/call`。
3. **Firecrawl 和 Exa 的 `Accept` 必须同时包含 `application/json` 与 `text/event-stream`。** 少一个直接 406。

## 架构

```
客户端 ── x-proxy-key ──► Worker
                            │
                            ├─ KV              服务注册表
                            │                  热路径只读，仅管理面写入
                            │
                            └─ Durable Object  每个服务一个
                                 └─ SQLite     密钥池，串行保证选键原子性
```

状态放在 Durable Object 的 SQLite 里而不是 KV，因为 KV 免费版每天只有 1000 次写入和 1000 次 list。任何基于 KV、每个请求都 list 一次写一次的实现，撑不到 500 次调用每天。DO 免费版每天 10 万行写入、500 万行读取，够用。

选键用「负载比最小优先」，按 `(使用次数 + 1) / 权重` 升序，同分再看最后使用时间。权重高的密钥要到相应用量才会追平这个比值，于是负载按权重摊开，不会一直压在同一把上。

密钥用 AES-GCM 加密后落库，主密钥来自 Worker secret，列表接口只返回掩码。

## 界面语言

管理面板支持英文、简体中文、日语、德语、法语，按浏览器 `Accept-Language` 自动选择，也可以用右上角下拉手动切换，或者用 `?lang=ja` 直接指定。

渲染在服务端完成，首屏就是正确语言，不闪。语言选择存在 cookie 里，下次直接生效。要加新语言，`src/i18n/` 下加一个文件即可，`Catalog` 类型会强制你覆盖全部键，漏翻直接编译报错，不会静默回落英文。

MCP 接口本身不本地化，这是刻意的。那些错误是给 MCP 客户端和集成方看的，不是给终端用户看的，而且 MCP 生态里错误消息惯例就是英文。

## 快速开始

需要一个 Cloudflare 账号，免费版即可。本仓库已经绑定了一个线上的 KV 命名空间，直接在 Cloudflare 控制台接 Git 部署即可跑起来。如果要 fork 到自己账号，把 `wrangler.toml` 里的 KV id 换成自己创建的。

```bash
pnpm install

# 1. 创建 KV 命名空间，把返回的 id 填进 wrangler.toml
npx wrangler kv namespace create REGISTRY

# 2. 设置两个密钥
npx wrangler secret put PROXY_KEY        # 客户端用来认证代理
npx wrangler secret put ENCRYPTION_KEY   # 密钥池落库加密，随便一串 32 字节以上

# 3. 部署
pnpm deploy
```

部署后访问 `https://你的域名/admin`，用 `PROXY_KEY` 登录。

新增服务时可以从预置里选 Tavily、Firecrawl 或 Exa，凭证字段名和额度状态码会自动填好。自定义服务填服务 ID、上游地址、凭证字段名即可。

然后粘贴密钥，一行一个，批量导入。想给密钥加备注，就在密钥后面跟一个逗号再写备注：

```
tvly-abc123,小号一号
tvly-def456,备用
tvly-ghi789
```

备注只是给人看的，代理不会把它发给上游。面板里每条密钥后面有个「备注」按钮，可以随时改或者清空。

## 客户端接入

```
https://你的域名/服务ID/mcp
```

请求头带 `x-proxy-key`。以 opencode 为例：

```jsonc
{
  "mcp": {
    "servers": {
      "tavily": {
        "type": "remote",
        "url": "https://你的域名/tavily/mcp",
        "headers": { "x-proxy-key": "你的 PROXY_KEY" }
      }
    }
  }
}
```

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| ANY | `/:service/mcp` | 透明转发到该服务的上游 |
| GET | `/admin` | 控制面板 |
| GET | `/api/services` | 服务列表及各自密钥统计 |
| POST | `/api/services` | 新增或更新服务 |
| DELETE | `/api/services/:id` | 删除服务及其密钥 |
| GET | `/api/services/:id/keys` | 列出密钥，只返回掩码 |
| POST | `/api/services/:id/keys` | 批量添加密钥，每行一个，可选 `密钥,备注` |
| PATCH | `/api/services/:id/keys/:keyId` | 改权重、状态或备注 |
| DELETE | `/api/services/:id/keys` | 批量删除 |
| POST | `/api/services/:id/keys/sync` | 从上游拉取真实余额 |

除 `/` 和 `/admin` 外全部需要 `x-proxy-key`。

## 失败判定

判定分三层，顺序固定：

1. **HTTP 状态码。** 命中配置的失效、耗尽或限流状态码直接定性。Tavily 的 432 和 433 都算额度耗尽。
2. **JSON-RPC 错误信封。** 顶层有 `error` 对象时按消息归类。
3. **结果对象。** 只在 `result.isError` 为真，或正文里存在显式 error 信封时才启用文本匹配。这一层是为了避免把搜索结果里正常出现的 `unauthorized` 字样误判成密钥失效。

重放的安全边界：

- HTTP 状态行上的鉴权失效、额度耗尽、限流会重放。这一类是传输层直接拒绝，上游没有开工，也没有扣费。
- 同样的失败包在 HTTP 200 body 里时，只有确认可以重复的请求才重放：本身不可能有副作用的协议方法，或者声明了 `readOnlyHint`、`idempotentHint` 的工具。body 里的失败只说明执行失败，不能说明没执行过；取消响应流也不会撤销上游已经在跑的任务。
- 工具注解从代理本来就要转发的 `tools/list` 响应里取，客户端先列工具再调用就能覆盖，不额外发请求。代理没见过的工具，或者列出来但没带注解的工具，一律按不安全处理。
- 5xx 和网络错误默认不重放，因为无法确认上游是否已经开始工作。只有服务配置里显式打开 `retryOn5xx` 才重放。
- 非幂等工具比如研究任务，一旦拿到任务 ID 就不再重放。

## 已知限制

首事件窥探只覆盖同步类工具。如果某个工具先推进度通知、真正的结果在后面的帧里，第一帧判定不出来，这次请求会按正常流程透传，不做重放。这是刻意选择：要覆盖这种情况就得全量缓冲，代价是失去流式。

上游把错误包在结果正文而不是 `isError` 里的非常规实现，需要按服务补充判定规则。

多账号绕免费额度违反多数服务的使用条款，账号被批量封是常见结果。密钥池能扛住大面积失效，但不代表不会发生。

## 开发

```bash
pnpm dev          # 本地起服务
pnpm typecheck    # 类型检查
pnpm test         # 单元测试与 Miniflare 集成测试
pnpm e2e          # 打真实 Exa 端点，验证换 key 重放
pnpm check:ui     # 检查面板内联脚本语法
```

测试直接用 Node 自带的运行器，不需要额外装 vitest。`pnpm test` 会跑 175 个用例，其中集成测试会在 Miniflare 里拉起真实的 KV 和 SQLite Durable Object，并覆盖语言协商、cookie 优先级和目录完整性。

判定逻辑在 `src/classify.ts`，转发与重放在 `src/forward.ts`，密钥池在 `src/pool.ts`。

## 许可

MIT
