# multi-mcp-proxy

一个部署在 Cloudflare Workers 上的多服务 MCP 透明反向代理，为每个服务维护独立的 API 密钥池。

指向某个服务的请求会原样转发到上游 MCP 端点，代理只替换凭证那一行请求头。上游判定某把密钥额度耗尽或已失效时，代理自动换下一把重放，客户端无感知。

## 为什么需要它

主流 MCP 托管端点把额度耗尽和鉴权失败都塞进 HTTP 200 的响应体里：

```
event: message
data: {"result":{"content":[{"type":"text","text":"The Firecrawl API key is invalid or revoked."}],"isError":true},"jsonrpc":"2.0","id":9}
```

状态码是 200，纯 header 层的反代看不到任何异常。结果就是一把密钥失效后，所有请求都会继续打在它上面，客户端拿到的是错误文本，代理毫不知情。

这个项目在响应流上做一次首事件窥探，判定失败就换密钥重放，判定正常就把已读字节补发回去接着流式转发。

## 实测依据

设计不是照文档写的，上线前对三个上游逐个探过：

| 上游 | 端点 | 凭证方式 | 无额度信号 | 会话绑定密钥 |
|---|---|---|---|---|
| Tavily | `mcp.tavily.com/mcp` | 仅 `Authorization: Bearer` | 432 与 200 正文 | 否 |
| Firecrawl | `mcp.firecrawl.dev/mcp` | `x-api-key` 或 Bearer | 200 正文 isError | 否 |
| Exa | `mcp.exa.ai/mcp` | `x-api-key`、Bearer 或 URL 参数 | 200 正文 isError | 否 |

三条关键事实：

1. 会话不绑定密钥。用 A 建的会话，换 B 调用，上游用的是 B。所以换密钥不需要重建会话。
2. `initialize` 和 `tools/list` 不校验额度。池化只需要发生在 `tools/call`。
3. Firecrawl 和 Exa 的 `Accept` 必须同时包含 `application/json` 与 `text/event-stream`，否则直接 406。

## 架构

```
客户端 ── x-proxy-key ──► Worker
                            │
                            ├─ KV      服务注册表（只读热路径，仅管理面写入）
                            │
                            └─ Durable Object (每个服务一个)
                                 └─ SQLite 密钥池，串行保证选键原子性
```

状态放在 Durable Object 的 SQLite 里而不是 KV，因为 KV 免费版每天只有 1000 次写入和 1000 次 list。现有那些基于 KV 的实现每个请求都要 list 一次写一次，撑不到 500 次调用每天。DO 免费版每天 10 万行写入、500 万行读取，够用。

选键用「负载比最小优先」，按 `(使用次数 + 1) / 权重` 升序，同分再看最后使用时间。权重高的密钥自然多承担，也不会一直压在同一把上。

密钥用 AES-GCM 加密后落库，主密钥来自 Worker secret，列表接口只返回掩码。

## 快速开始

需要一个 Cloudflare 账号，免费版即可。本仓库已经绑定了一个线上的 KV 命名空间，直接在 Cloudflare 控制台接 Git 部署即可跑起来。如果是 fork 到自己账号，把 `wrangler.toml` 里的 KV id 换成自己创建的。

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

新增服务时可以从预置里选 Tavily、Firecrawl 或 Exa，字段会自动填好。自定义服务填服务 ID、上游地址、凭证字段名即可。

然后粘贴密钥，一行一个，批量导入。

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
| POST | `/api/services/:id/keys` | 批量添加密钥 |
| PATCH | `/api/services/:id/keys/:keyId` | 改权重、状态或备注 |
| DELETE | `/api/services/:id/keys` | 批量删除 |
| POST | `/api/services/:id/keys/sync` | 从上游拉取真实余额 |

除 `/` 和 `/admin` 外全部需要 `x-proxy-key`。

## 失败判定

判定分三层，顺序固定：

1. HTTP 状态码。命中配置的失效、耗尽或限流状态码直接定性。Tavily 的 432 和 433 都算额度耗尽。
2. JSON-RPC 错误信封。顶层有 `error` 对象时按消息归类。
3. 结果对象。只在 `result.isError` 为真，或正文里存在显式 error 信封时才启用文本匹配。这一层是为了避免把搜索结果里正常出现的 `unauthorized` 字样误判成密钥失效。

重放的安全边界：

- 鉴权失效、额度耗尽、限流会重放。这三类都意味着上游在扣费之前就拒绝了。
- 5xx 和网络错误默认不重放，因为无法确认上游是否已经开始工作。只有服务配置里显式打开 `retryOn5xx` 且判定认为请求未被处理时才重放。
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

测试直接用 Node 自带的运行器，不需要额外装 vitest。`pnpm test` 会跑 73 个用例，其中集成测试会在 Miniflare 里拉起真实的 KV 和 SQLite Durable Object。

判定逻辑在 `src/classify.ts`，转发与重放在 `src/forward.ts`，密钥池在 `src/pool.ts`。

## 许可

MIT
