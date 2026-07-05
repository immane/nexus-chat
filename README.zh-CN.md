<p align="center">
  <img src="https://img.shields.io/badge/phase-1%20complete-blue" alt="Phase">
  <img src="https://img.shields.io/badge/coverage-99.8%25-brightgreen" alt="Coverage">
  <img src="https://img.shields.io/badge/tests-72%20passed-green" alt="Tests">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node">
  <img src="https://img.shields.io/badge/pnpm-9.15-orange" alt="pnpm">
</p>

# Nexus Chat

一个类 Slack 的工作区聊天系统，采用**混合加密**模式：普通频道支持 Bot、消息历史和服务端工作流；端到端加密 DM 中服务端只能看到密文。使用 TypeScript、React、Electron、Hono 和 Socket.IO 从零构建。

Phase 1 交付了一个完整的 monorepo，包含 Web 客户端、Electron 桌面壳、TUI/CLI、REST/WebSocket 网关、完整的消息状态机、带 SDK 的 Bot 引擎、三个第一方 Bot 和 Signal 风格 E2EE 服务边界。测试套件覆盖 17 个文件、72 个测试，statement coverage 持续超过 99%。

---

## 目录

- [加密模型](#加密模型)
- [架构](#架构)
- [快速开始](#快速开始)
- [仓库结构](#仓库结构)
- [技术栈](#技术栈)
- [消息生命周期](#消息生命周期)
- [Bot 框架](#bot-框架)
- [E2EE 设计](#e2ee-设计)
- [安全](#安全)
- [API 参考](#api-参考)
- [WebSocket 协议](#websocket-协议)
- [测试与覆盖率](#测试与覆盖率)
- [配置](#配置)
- [文档](#文档)
- [已知限制](#已知限制)
- [贡献](#贡献)
- [许可证](#许可证)

---

## 加密模型

每个频道和 DM 独立选择加密级别，不存在全局开关。

| 模式 | 服务端内容 | Bot 可用 | 服务端搜索 | 消息功能 |
| --- | --- | --- | --- | --- |
| **普通** | 明文 | 是 | 未来（Phase 2） | 完整：reaction、编辑、删除、转发、收藏、已读回执 |
| **E2EE** | 仅密文 | 否 — 网关层拒绝 | 禁用 | 受限：read-once、TTL 过期、删除时 tombstone |

**关键设计属性：**

- 加密模式按频道存储在数据库中。客户端和服务端在频道创建时约定模式。
- E2EE 频道只接受 `content.type === "ciphertext"`。向 E2EE 频道发送普通明文消息会返回 `VALIDATION_FAILED`。
- Bot 不能加入 E2EE 频道。如果 Bot 尝试加入、安装到或向 E2EE 频道发送消息，服务端返回 `E2E_BOT_NOT_ALLOWED`。
- 所有 Bot 事件（`bot.command.invoke`、`message.created`）在 E2EE 频道中被抑制 — Bot 引擎在 `channel.mode === "e2e"` 时跳过 dispatch。
- E2EE 附件元数据同样受限：加密文件必须携带 `scanStatus: "skipped"`。非 skipped 的 E2EE 附件会被拒绝。

---

## 架构

```
┌──────────────────────────────────────────────────┐
│  客户端                                           │
│  Electron  ·  React/Vite Web  ·  TUI (Commander) │
└────────────────────────┬─────────────────────────┘
                         │  REST (Hono)  +  Socket.IO
                         ▼
┌──────────────────────────────────────────────────┐
│  网关层                                           │
│  HTTP API (CORS, Helmet, 限流)                    │
│  WebSocket (auth, rooms, 每用户速率限制)           │
│  /bots WS namespace (token auth, 事件轮询)        │
└────────────────────────┬─────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                 ▼
┌───────────┐  ┌──────────────┐  ┌──────────────┐
│  Auth     │  │  Workspace   │  │  Signal/E2EE │
│  Service  │  │  Service     │  │  Service     │
│           │  │              │  │              │
│ 注册      │  │ CRUD         │  │ PreKey CRUD  │
│ 登录      │  │ 成员/RBAC    │  │ Bundle 获取  │
│ 刷新      │  │ Channels/DMs │  │ OPK 消费     │
│ 登出      │  │ 所有权转移    │  │ 会话         │
└───────────┘  └──────────────┘  └──────────────┘
        │                │                 │
        └────────────────┼─────────────────┘
                         ▼
┌──────────────────────────────────────────────────┐
│  Message Service                                  │
│  Send · Edit · Delete · React · Forward · Save    │
│  AckRead · List · ListPage · CleanupExpired       │
│  状态机: SENDING→SENT→DELIVERED→READ              │
└────────────────────────┬─────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────┐
│  Bot Engine                                       │
│  Install · ValidateToken · Subscribe/Poll          │
│  invokeCommand · sendBotMessage · publishEvent     │
│  内联 /help handler（无需 Bot 客户端连接）         │
└──────────────────────────────────────────────────┘
```

**Phase 1 的数据层：** Domain services 使用内存 store（基于 `Map`）。完整的 PostgreSQL schema（17 个表，Drizzle ORM）和 Redis 基础设施已通过 migration 定义和验证，但运行时 store 层尚未接入 Postgres。通过 `SESSION_STORE=redis` 路径可以测试 Redis 支持的 refresh session（`RedisRefreshSessionStore`）。

**普通消息发送的数据流：**

1. Web 客户端通过 Socket.IO 发送 `{ type: "message.send", payload: { workspaceId, channelId, clientMsgId, content } }`。
2. 网关用 Zod schema 验证 WS envelope 和内层 payload。
3. `messageService.send()` 检查频道访问权限、模式兼容性、幂等性（`clientMsgId`）和附件有效性。
4. 创建新消息，id 为 UUID v7，状态为 `"sent"`，存储在内存中。
5. 如果频道是 normal 模式，`botService.publishEvent({ type: "message.created", ... })` 分发给已订阅的 Bot。
6. 网关向频道 room 中的所有客户端广播 `{ type: "message.created", payload: message }`。
7. 客户端用 `{ type: "message.ack", payload: { messageId } }` 确认。
8. 已读回执在内存中缓冲并按批次刷新（设计中为 3 秒窗口，Phase 1 为即时刷新）。

---

## 快速开始

**前置要求：** Node.js >=22、pnpm 9.15.x、Docker。

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

服务端启动在 `http://localhost:4000`，Web 客户端在 `http://localhost:5173`。

**Seed 测试账号：**

| Email | Password |
| --- | --- |
| `ada@example.com` | `Password12345!` |
| `grace@example.com` | `Password12345!` |

你也可以在 Web app 中直接注册用户或通过 API 注册。详见 [QUICKSTART.zh-CN.md](QUICKSTART.zh-CN.md) 获取分步指南和故障排查。

---

## 仓库结构

```
nexus-chat/
├── apps/
│   ├── server/           Hono REST API, Socket.IO, domain services, Drizzle
│   │   └── src/
│   │       ├── domain/   Auth, Workspaces, Messages, Bots, Signal, Attachments
│   │       ├── http/     路由处理, 中间件, 限流
│   │       ├── ws/       Socket.IO 网关和事件分发
│   │       ├── db/       Drizzle schema, client, migrations, seed
│   │       ├── config/   环境配置
│   │       └── observability/  Pino logger, Prometheus, audit
│   ├── web/              React 19 + Vite + Zustand + Tailwind CSS
│   │   └── src/
│   │       ├── components/  App shell, 频道侧边栏, 消息列表
│   │       └── stores/      Auth, workspace, channel, message, presence, UI
│   ├── desktop/          Electron main/preload（安全默认配置）
│   └── tui/              Commander CLI + Ink 交互式 UI
├── packages/
│   ├── shared/           40+ Zod schemas, 协议类型, API envelope 辅助函数
│   ├── signal/           本地 Signal 风格 facade（pre-key, encrypt/decrypt）
│   ├── bot-sdk/          NexusBotClient: WS 连接, middleware, 事件分发
│   ├── ui/               共享 React primitives 和 design tokens
│   └── bots/
│       ├── help/         响应 /help
│       ├── notification/ 响应 /announce
│       └── welcome/      在 member_added 事件时发送引导消息
├── docs/                 架构, 研究, 任务, SDK 指南, beta 文档
├── docker-compose.yml    PostgreSQL 16 + Redis 7
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

---

## 技术栈

| 层级 | 技术 | Phase 1 角色 |
| --- | --- | --- |
| **语言** | TypeScript `strict` | 全部代码 |
| **Monorepo** | pnpm workspaces + Turborepo | 依赖图, 并行构建 |
| **HTTP** | Hono 4.x | 所有 REST 路由, Zod 验证中间件 |
| **WebSocket** | Socket.IO 4.x | 客户端网关 + `/bots` namespace |
| **认证** | `@node-rs/argon2`, `jsonwebtoken` (RS256) | 密码哈希, JWT 签名/验证 |
| **Schema** | Zod 3.x | 每个 I/O 边界: API, WS, bots, E2EE |
| **ORM** | Drizzle ORM 0.38 | Schema 定义, migrations, seed |
| **数据库** | PostgreSQL 16 (Docker) | Schema 已就绪；运行时使用内存 store |
| **缓存** | Redis 7 (Docker) | Session store (Redis 模式), 为 pub/sub 做准备 |
| **前端** | React 19, Vite, Zustand 5, Tailwind CSS, React Virtuoso | Web 客户端 |
| **桌面** | Electron | BrowserWindow, preload IPC, tray, 通知 |
| **CLI** | Commander, Ink (React 19) | TUI 聊天, smoke tests |
| **可观测性** | Pino, `prom-client` | 结构化日志, request IDs, metrics |
| **测试** | Vitest + V8 coverage | 17 个测试文件, 72 个测试 |

---

## 消息生命周期

### 状态机

```
DRAFT ──→ SENDING ──→ SENT ──→ DELIVERED ──→ READ
                        │
                        └──→ FAILED（重试 ≤3，指数退避）
                              └──→ DELETED（tombstone）
```

### 幂等性

每条消息携带一个 `clientMsgId`（客户端生成的唯一字符串）。服务端存储 `(senderId, clientMsgId)` 映射。重复发送返回已存在的消息 — 无重复行，无重放副作用。

### 分页

消息按 `(channel_id, created_at DESC, id DESC)` 排序。API 使用基于游标的分页，以消息 `id` 作为游标。这避免了在插入新消息时的偏移量漂移。

### 已读回执

已读回执（`message.ack`）在内存中缓冲。设计上要求 3 秒 Redis 刷新窗口；Phase 1 通过 `messageService.flushReadReceipts()` 实现即时刷新。

### E2EE 消息处理

- **Read-once：** 当带有 `readOnce: true` 的 ciphertext 消息被确认时，立即 tombstone 处理（`type: "tombstone"`, `reason: "read_once_consumed"`）。
- **TTL 过期：** `messageService.cleanupExpiredMessages()` 扫描超过 `expiresAt` 的 ciphertext 消息，并将其替换为 `reason: "expired"` tombstone。
- **普通删除：** `softDelete` 生成 `reason: "deleted"` tombstone。原始密文永远不会泄露。

---

## Bot 框架

### 架构

Bot 连接到专用的 `/bots` Socket.IO namespace，使用 Bot 专属 token 认证。该 namespace 运行一个事件轮询循环（500ms 间隔），将待处理事件推送给已连接的 Bot。

### 生命周期

1. **安装：** `POST /api/v1/bots/install`，传入 manifest。返回 `nxbot_v1_...` token。
2. **频道成员：** `POST /api/v1/bots/:botId/channels/:channelId`。Bot 需要 `channels:read` scope。
3. **事件订阅：** `POST /api/v1/bots/subscriptions?eventType=message.created`。已订阅事件通过 `dispatchToBots` 分发。
4. **发送消息：** Bot 使用其 token 调用 `POST /api/v1/bots/messages`。服务端验证 scope（`messages:write`）、频道成员关系和 E2EE 限制。

### Bot SDK

```ts
import { NexusBotClient } from "@nexus-chat/bot-sdk";

const bot = new NexusBotClient({
  baseUrl: "http://localhost:4000",
  token: "nxbot_v1_...",
  manifest: {
    id: "my-bot",
    name: "MyBot",
    commands: [{ name: "/echo", description: "回显输入" }],
    scopes: ["commands:handle", "messages:write"]
  }
});

bot.use(async (event, next) => { /* 中间件 */ await next(); });
bot.onCommand("/echo", async (event) => { /* 处理命令 */ });
bot.onEvent("message.created", async (event) => { /* 处理事件 */ });
bot.connect();
```

**SDK 特性：**
- 自动重连，指数退避 + jitter（最多 10 次重试，1s-30s 窗口）。
- `use()` 中间件管道。
- 类型安全的 `sendMessage()`、`getChannelInfo()`、`subscribe()`/`unsubscribe()` REST 辅助函数。
- `redactToken()` 日志安全工具。

### 内联 `/help`

服务端无需 Bot 客户端连接即处理 `/help`。`botService.invokeCommand` 检测 `command === "/help"`，查找 manifest 中声明了 `/help` 命令的已安装 Bot，生成列出所有命令的响应消息，并广播到频道。即使没有 Bot 连接到 `/bots`，此功能也能正常工作。

### 事件类型

| 事件 | 触发条件 |
| --- | --- |
| `bot.command.invoke` | 用户通过 WS 发送 slash command |
| `message.created` | 普通模式消息被发送 |
| `workspace.member_added` | 成员加入工作区 |

---

## E2EE 设计

### 服务边界

`apps/server/src/domain/signal/service.ts` 中的 `signalService` 提供服务端 pre-key 基础设施：

- **上传 bundle：** 存储 identity key、signed pre-key 和可选的 one-time pre-keys。
- **获取 bundle：** 检索 pre-key bundle 并事务性地消费一个 one-time pre-key。
- **消费 one-time pre-key：** 标记特定 OPK 为已消费（幂等；如果已消费则返回 `CONFLICT`）。
- **会话存储：** 存储链接到 owner 和 peer 用户 ID 的 Signal 会话。

### 客户端 Facade

`packages/signal` 提供一个本地 facade，包含 `generateIdentity`、`generatePreKeyBundle`、`encryptMessage` 和 `decryptMessage`。用于测试和 smoke scripts。生产级 Signal Protocol 集成（`@signalapp/libsignal-client`）是 AGPL-3.0 依赖项，正在评估许可影响。

### E2EE 频道限制

- 只接受 `content.type === "ciphertext"`。
- Bot 在网关、服务和频道成员层面均被拒绝。
- 附件必须携带 `scanStatus: "skipped"` — 无服务端病毒扫描。
- 服务端消息事件（`message.created`）在 E2EE 频道中不生成。

---

## 安全

| 层级 | 实现 |
| --- | --- |
| 密码哈希 | Argon2id (`memoryCost: 65536, timeCost: 3, parallelism: 4`) |
| Access tokens | JWT RS256, 15 分钟过期, `sub` claim |
| Refresh tokens | 不透明 `nxrefresh_...`, 7 天过期, 一次性旋转, 重放检测 |
| Session 后端 | `InMemoryRefreshSessionStore`（开发）或 `RedisRefreshSessionStore` |
| 限流 | 按 IP 的登录限流 + 按用户的 WS 事件限流（50 events/10s） |
| CORS | 通过 `WEB_ORIGIN` 配置的 origin |
| 安全响应头 | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `X-XSS-Protection` |
| 日志脱敏 | Pino redaction 处理 secrets, tokens, passwords |
| 审计追踪 | 内存 audit events，覆盖 auth, workspace, channel, bot, attachment 操作 |

---

## API 参考

所有路由挂载在 `/api/v1` 下。受保护路由需要 `Authorization: Bearer <accessToken>`。

### Auth

| Method | Path | Body/Notes |
| --- | --- | --- |
| `POST` | `/auth/register` | `{ email, password, displayName }` |
| `POST` | `/auth/login` | `{ email, password }` — 按 IP+email 限流 |
| `POST` | `/auth/refresh` | `{ refreshToken }` — 旋转 token，检测重放 |
| `POST` | `/auth/logout` | `{ refreshToken }` — 撤销 session |
| `GET` | `/auth/me` | 返回当前用户 |

### Workspaces

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/workspaces` | `{ name }` — 自动创建 #general 频道 |
| `GET` | `/workspaces` | 列出用户的工作区 |
| `GET` | `/workspaces/:id` | 获取工作区详情 |
| `PATCH` | `/workspaces/:id` | `{ name }` — 仅 owner/admin |
| `POST` | `/workspaces/:id/members` | `{ userId, role }` — 添加成员 |
| `DELETE` | `/workspaces/:id/members/:userId` | 移除成员 |
| `GET` | `/workspaces/:id/members` | 列出成员 |
| `POST` | `/workspaces/:id/transfer-ownership` | `{ newOwnerUserId }` |

### Channels & DMs

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/workspaces/:id/channels` | `{ name, mode, isPrivate }` |
| `GET` | `/workspaces/:id/channels` | 列出可访问的频道 |
| `POST` | `/channels/:id/members` | `{ userId }` |
| `DELETE` | `/channels/:id/members/:userId` | |
| `GET` | `/channels/:id/members` | |
| `POST` | `/channels/:id/archive` | |
| `DELETE` | `/channels/:id` | 软删除 |
| `POST` | `/dms?workspaceId=...` | `{ peerUserId, mode }` — 幂等 |

### Messages

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/messages` | `{ workspaceId, channelId, clientMsgId, content }` |
| `GET` | `/channels/:id/messages` | `?cursor=&limit=` — 游标分页 |
| `PATCH` | `/messages/:id` | `{ text }` — 仅编辑自己的文本消息 |
| `DELETE` | `/messages/:id` | 软删除 → tombstone |
| `POST` | `/messages/:id/reactions` | `{ emoji }` — toggle add/remove |
| `POST` | `/messages/:id/forward` | `{ targetChannelId, clientMsgId }` |
| `POST` | `/messages/:id/save` | 收藏消息 |

### Bots

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/bots/install?workspaceId=...` | `BotManifest` — 返回 token |
| `POST` | `/bots/:botId/channels/:channelId` | 将 Bot 加入频道 |
| `DELETE` | `/bots/:botId/channels/:channelId` | 从频道移除 Bot |
| `POST` | `/bots/subscriptions?eventType=...` | 订阅（Bot token 认证） |
| `DELETE` | `/bots/subscriptions?eventType=...` | 取消订阅（Bot token 认证） |
| `GET` | `/bots/:botId/subscriptions` | |
| `POST` | `/bots/messages` | Bot 认证的消息发送 |
| `POST` | `/bots/commands` | HTTP fallback 命令行调用 |

### Signal / E2EE

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/signal/prekey-bundles` | 上传 identity + pre-keys |
| `GET` | `/signal/prekey-bundles/:userId/:deviceId` | 获取并消费 OPK |
| `POST` | `/signal/prekey-bundles/:userId/:deviceId/consume?keyId=` | 显式 OPK 消费 |
| `GET` | `/signal/prekey-bundles/:userId/:deviceId/count` | 剩余 OPK 数量 |
| `POST` | `/signal/sessions?peerUserId=&deviceId=` | 存储会话 |
| `GET` | `/signal/sessions` | 列出用户会话 |
| `GET` | `/signal/sessions/:id` | 获取会话 |

### Attachments

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/attachments/upload-sessions` | 创建预签名 session |
| `POST` | `/attachments/upload-sessions/:id/complete` | 标记上传完成 |
| `GET` | `/attachments/:fileId` | 文件元数据 |
| `POST` | `/attachments/:fileId/download-url` | 生成下载 URL |

### Ops

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/healthz` | `{ status: "ok" }` |
| `GET` | `/metrics` | Prometheus text 格式 |

---

## WebSocket 协议

客户端使用 JWT 认证连接到主 namespace，并自动加入每个可访问频道的 room（`channel:<id>`）和用户收件箱（`user:<userId>`）。

### Client → Server events

| Event | Payload | Notes |
| --- | --- | --- |
| `message.send` | `{ workspaceId, channelId, clientMsgId, content }` | 创建并广播消息 |
| `message.ack` | `{ messageId }` | 标记已读，刷新 receipts |
| `bot.command.invoke` | `{ type, workspaceId, channelId, botName, command, args[] }` | 路由至 Bot engine |
| `typing.start` | `{ workspaceId, channelId }` | 广播 `typing.updated` |
| `typing.stop` | `{ workspaceId, channelId }` | 广播 `typing.updated` |
| `presence.update` | `{ status }` | 发送 `presence.updated` 给自己 |

### Server → Client events

| Event | Payload |
| --- | --- |
| `message.created` | 完整 `Message` 对象 |
| `message.updated` | 更新后的 `Message` |
| `message.deleted` | Tombstone 处理后的 `Message` |
| `message.reaction` | `{ messageId, emoji, count, reacted }` |
| `message.read` | `{ messageId, channelId, readCount, readers[], flushedAt }` |
| `typing.updated` | `{ userId, channelId, workspaceId, typing }` |
| `presence.updated` | `{ userId, status }` |

---

## 测试与覆盖率

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm coverage && pnpm build
```

**覆盖率**（V8，workspace 全局）：

| 指标 | 数值 |
| --- | --- |
| Statements | 99.83% |
| Branches | 92.02% |
| Functions | 99.23% |
| Lines | 99.83% |

**测试分布（17 files, 72 tests）：**

| Package | 测试文件 | 测试数 |
| --- | --- | --- |
| `@nexus-chat/server` | `domain/services.test.ts` | 14 |
| `@nexus-chat/server` | `ws/gateway.test.ts` | 5 |
| `@nexus-chat/server` | `http/routes.test.ts` | 3 |
| `@nexus-chat/server` | `observability/audit.test.ts` | 4 |
| `@nexus-chat/server` | `domain/auth/session-store.test.ts` | 2 |
| `@nexus-chat/server` | `observability/logger.test.ts` | 1 |
| `@nexus-chat/server` | `db/schema.test.ts` | 2 |
| `@nexus-chat/bot-sdk` | `index.test.ts` | 11 |
| `@nexus-chat/shared` | `index.test.ts` | 5 |
| `@nexus-chat/web` | `stores/domain.test.ts` | 4 |
| `@nexus-chat/web` | `components/App.test.tsx` | 3 |
| `@nexus-chat/help-bot` | `index.test.ts` | 2 |
| `@nexus-chat/notification-bot` | `index.test.ts` | 2 |
| `@nexus-chat/welcome-bot` | `index.test.ts` | 2 |
| `@nexus-chat/signal` | `index.test.ts` | 3 |
| `@nexus-chat/tui` | `index.test.ts` | 5 |
| `@nexus-chat/desktop` | `config.test.ts` | 4 |

CI 在每次 push 时运行：lint、typecheck、test、coverage、build、dependency audit 和 TUI smoke tests。

---

## 配置

复制 `.env.example` 到 `.env`。所有变量：

| Variable | 默认值 | 用途 |
| --- | --- | --- |
| `NODE_ENV` | `development` | 运行时环境 |
| `PORT` | `4000` | HTTP + WebSocket 服务端端口 |
| `WEB_ORIGIN` | `http://localhost:5173` | CORS 允许的 origin |
| `DATABASE_URL` | `postgres://nexus:nexus@localhost:5432/nexus_chat` | PostgreSQL 连接 |
| `REDIS_URL` | `redis://localhost:6379` | Redis 连接 |
| `SESSION_STORE` | `memory` | `memory` 或 `redis` |
| `JWT_ISSUER` | `nexus-chat` | `iss` claim |
| `JWT_AUDIENCE` | `nexus-chat-clients` | `aud` claim |
| `JWT_KID` | `local-dev` | JWT header 中的 Key ID |
| `JWT_PRIVATE_KEY_PEM` | *(自动生成)* | RS256 签名密钥 |
| `JWT_PUBLIC_KEY_PEM` | *(自动生成)* | RS256 验证密钥 |
| `LOG_LEVEL` | `info` | Pino 日志级别 |
| `VITE_API_BASE` | `http://localhost:4000` | Web 客户端 API URL |
| `OBJECT_STORAGE_ENDPOINT` | `http://localhost:9000` | S3 兼容 endpoint |
| `OBJECT_STORAGE_BUCKET` | `nexus-chat-local` | 存储 bucket 名称 |

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [QUICKSTART.zh-CN.md](QUICKSTART.zh-CN.md) | 分步本地搭建指南（含故障排查） |
| [docs/ai/context.md](docs/ai/context.md) | AI agent 完整会话上下文 |
| [docs/design/](docs/design/) | 架构文档（6 篇，5 层 + roadmap） |
| [docs/research/](docs/research/) | 技术调查：后端, 前端, E2EE, bots, UI, AI |
| [docs/tasks/](docs/tasks/) | 17 个实现任务分解 |
| [docs/sdk/](docs/sdk/) | Bot SDK 指南（Node.js, Java, Python, PHP, Go, Rust） |
| [docs/beta-checklist.md](docs/beta-checklist.md) | 封闭测试就绪检查表 |
| [docs/backup-restore.md](docs/backup-restore.md) | 备份和恢复流程 |
| [docs/known-limitations.md](docs/known-limitations.md) | Phase 1 限制和计划解决方案 |

---

## 已知限制

Phase 1 是本地开发和封闭测试里程碑。主要限制：

- **内存 store：** Domain services 使用 `Map` 基于的状态。PostgreSQL schema 和 migrations 已定义，但运行时持久化层尚未接入。Redis 可通过 `SESSION_STORE=redis` 用于 session 存储。
- **单设备 E2EE：** 每用户一个设备。多设备支持和群组 E2EE（Sender Key）已推迟。
- **无全文搜索：** 消息搜索限于基于游标的分页。`tsvector` 索引计划在 Phase 2 实现。
- **无 WebSocket 水平扩展：** Socket.IO 在开发环境中单进程运行，不使用 Redis Adapter。
- **Electron 打包：** 无生产代码签名、公证或自动更新发布。
- **附件 UX：** 服务端附件基元已存在；Web/Desktop 上传 UI 尚未构建。

完整列表见 [docs/known-limitations.md](docs/known-limitations.md)。

---

## 贡献

- **语言：** 所有文档、注释和 commit message 使用英文。
- **代码风格：** TypeScript strict mode, ESLint, Prettier。无理由不使用 `any`。
- **验证：** 每个 I/O 边界使用 Zod（HTTP, WS, bot events, E2EE metadata）。
- **Commits：** Conventional Commits（`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`）。
- **PR 前：** `pnpm lint`, `pnpm typecheck`, `pnpm test`。

完整约定参见 `AGENTS.md`。

---

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
