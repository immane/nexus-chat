# Nexus Chat

[English README](README.md) | [Quick Start](QUICKSTART.md) | [中文快速开始](QUICKSTART.zh-CN.md)

Nexus Chat 是一个 Phase 1 阶段的类 Slack 工作区聊天系统，使用 TypeScript、React、Electron、Hono、Socket.IO、PostgreSQL schema 工具、Redis-ready 基础设施和第一方 Bot 框架构建。它展示了一种混合通信模型：普通明文频道支持 Bot、服务端工作流、消息历史和未来的服务端搜索；端到端加密会话则隔离 Bot 访问和服务端明文处理。

本仓库是一个 pnpm workspace monorepo，面向本地开发、架构实验和封闭测试准备。Phase 1 已完成，包含 Web 客户端、Electron 壳、TUI/CLI、后端网关、消息状态机、Bot 引擎、第一方 Bot、Signal 风格 E2EE 服务边界、可观测性和较完整的测试套件。

## 功能亮点

- 工作区级聊天，支持公开/私有频道和 1:1 DM。
- 普通模式消息支持 Bot、消息历史、reaction、编辑、删除、转发、收藏和已读回执。
- E2EE 模式频道只接受 ciphertext，并支持 read-once/TTL tombstone 边界。
- 基于 WebSocket 的 slash command 流程，包括内联 `/help` 响应。
- 独立 Bot 引擎，支持安装、频道成员关系、事件订阅、队列轮询和 Bot 身份发消息。
- 第一方 Bot：HelpBot、WelcomeBot、NotificationBot。
- Node.js Bot SDK，支持 middleware、command handler、event handler、重连逻辑和 REST helper。
- React/Vite Web 客户端，包含 demo 模式、真实服务端模式、频道侧边栏、成员/设置面板、虚拟化消息列表、slash command 建议和 E2EE 状态 UI。
- Electron 壳，包含安全 BrowserWindow 默认配置、preload IPC 边界、托盘、通知、剪贴板/窗口 API 和自动更新占位实现。
- TUI/CLI，支持登录、工作区/频道操作、发送消息、Bot smoke test 和 E2EE smoke test。
- Shared contracts 包，使用 Zod 定义 API、WebSocket、Bot、消息、附件、工作区、频道、认证和 Signal 边界。
- 安全基线：Argon2id 密码哈希、RS256 JWT、refresh token rotation、CORS、安全响应头、限流、结构化日志、Prometheus metrics 和 audit events。
- 高测试覆盖率：当前测试套件 statement coverage 超过 99%，branch coverage 超过 90%。

## 当前状态

Phase 1 已实现并通过本地验证。

| 模块 | 状态 |
| --- | --- |
| Monorepo scaffold | 完成 |
| Shared contracts 和运行时 schema | 完成 |
| 数据库 schema 和 migration 工具 | 完成 |
| Auth/session/security baseline | 完成 |
| REST gateway 和 WebSocket gateway | 完成 |
| Workspace/channel/DM 服务 | 完成 |
| Message service 和状态机 | 完成 |
| Attachment service foundation | 完成 |
| Signal/E2EE 服务边界 | 完成 |
| Bot engine 和 slash commands | 完成 |
| Node.js Bot SDK | 完成 |
| 第一方基础 Bot | 完成 |
| React web shell | 完成 |
| Electron shell | 完成 |
| 可观测性和 audit logs | 完成 |
| 本地开发、CI 和 smoke scripts | 完成 |
| TUI/CLI | 完成 |

重要 Phase 1 说明：PostgreSQL schema、migrations 和 seed script 已存在，但当前本地运行时 domain services 默认使用内存 store。Redis 可用于基础设施一致性，也可以通过 `SESSION_STORE=redis` 测试 Redis refresh session。生产使用前请阅读 [Known Limitations](docs/known-limitations.md)。

## 截图

某些本地工作区可能包含开发截图，但图片产物默认被 Git 忽略，以保持仓库历史轻量。如果需要在这里展示截图，建议将精选图片放到一个受版本控制的 docs assets 目录中。

## 架构

```text
Electron / Web / TUI Clients
        |
        | REST + Socket.IO
        v
Hono HTTP API + WebSocket Gateway
        |
        +--> Auth, Workspace, Channel, DM Services
        +--> Message Service and State Machine
        +--> Attachment Service Boundary
        +--> Signal/E2EE Service Boundary
        +--> Bot Engine and Event Dispatch
        |
        v
In-memory Phase 1 runtime stores
PostgreSQL schema/migrations + Redis-ready infrastructure
```

普通频道允许 Bot 事件和 Bot 消息。E2EE 频道只接受 ciphertext 消息内容，并显式拒绝 Bot 参与。

## Monorepo 结构

```text
nexus-chat/
├── apps/
│   ├── server/       Hono REST API、Socket.IO gateway、domain services
│   ├── web/          React 19 + Vite chat client
│   ├── desktop/      Electron shell 和 secure preload boundary
│   └── tui/          Commander + Ink CLI/TUI client
├── packages/
│   ├── shared/       Zod schemas、API envelopes、protocol contracts
│   ├── signal/       客户端/测试使用的本地 Signal 风格 facade
│   ├── bot-sdk/      TypeScript/Node.js Bot SDK
│   ├── ui/           共享 React UI primitives
│   └── bots/
│       ├── help/     用于 `/help` 的 HelpBot
│       ├── welcome/  成员入组 onboarding WelcomeBot
│       └── notification/ Announcement 工作流 NotificationBot
├── docs/             架构、研究、任务计划、beta 文档
├── docker-compose.yml
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 语言 | TypeScript strict mode |
| Monorepo | pnpm workspaces, Turborepo |
| 后端 | Hono, Socket.IO, Zod, Drizzle schema tooling |
| 认证 | Argon2id, JWT RS256, refresh-token rotation |
| 数据基础设施 | PostgreSQL 16 schema/migrations, Redis 7-ready sessions/cache |
| 前端 | React 19, Vite, Zustand, React Virtuoso, Tailwind CSS |
| 桌面端 | Electron |
| TUI/CLI | Commander, Ink |
| Bot 框架 | 独立 `/bots` namespace, Bot SDK, event subscriptions |
| E2EE 边界 | Signal 风格 pre-key/session services 和 ciphertext-only channels |
| 可观测性 | Pino logs, Prometheus metrics, audit events |
| 测试 | Vitest with V8 coverage |

## 前置要求

- Node.js 22 或更新版本。
- pnpm 9.15.x。本仓库声明了 `packageManager: pnpm@9.15.0`。
- Docker Desktop 或 Docker Engine，推荐用于 PostgreSQL 和 Redis。
- macOS、Linux 或 Windows，并具备可运行 pnpm scripts 的 shell。

## 快速开始

最短路径请看 [QUICKSTART.zh-CN.md](QUICKSTART.zh-CN.md)。

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

默认本地地址：

| 服务 | URL |
| --- | --- |
| Server API | `http://localhost:4000` |
| Health check | `http://localhost:4000/healthz` |
| Metrics | `http://localhost:4000/metrics` |
| Web client | `http://localhost:5173` |
| PostgreSQL | `localhost:5432` |
| Redis | `localhost:6379` |

PostgreSQL seed script 的测试账号：

| Email | Password |
| --- | --- |
| `ada@example.com` | `Password12345!` |
| `grace@example.com` | `Password12345!` |

由于 Phase 1 运行时服务默认使用内存 store，你也可以在 dev session 中通过 Web app 或 API 直接注册用户。

## 开发流程

安装依赖：

```bash
pnpm install
```

启动基础设施：

```bash
docker compose up -d
```

启动所有 dev tasks：

```bash
pnpm dev
```

单独启动 app：

```bash
pnpm --filter @nexus-chat/server dev
pnpm --filter @nexus-chat/web dev
pnpm --filter @nexus-chat/desktop dev
pnpm --filter @nexus-chat/tui dev -- --help
```

停止基础设施：

```bash
docker compose down
```

重置 PostgreSQL volume：

```bash
docker compose down -v
docker compose up -d
pnpm db:migrate
pnpm db:seed
```

## Scripts

| Script | 说明 |
| --- | --- |
| `pnpm dev` | 通过 Turborepo 启动所有 package/app 的 dev tasks。 |
| `pnpm build` | 构建所有 apps 和 packages。 |
| `pnpm test` | 运行全部测试套件。 |
| `pnpm coverage` | 使用 Vitest + V8 coverage 运行 workspace coverage。 |
| `pnpm lint` | 运行全仓库 ESLint。 |
| `pnpm typecheck` | 运行全仓库 TypeScript type-check。 |
| `pnpm format` | 使用 Prettier 格式化文件。 |
| `pnpm format:check` | 只检查格式，不写入文件。 |
| `pnpm db:generate` | 根据 server schema 生成 Drizzle migrations。 |
| `pnpm db:migrate` | 应用 Drizzle migrations。 |
| `pnpm db:seed` | 向 PostgreSQL 写入本地示例数据。 |
| `pnpm smoke:tui` | 运行 TUI login、Bot command、E2EE flow smoke tests。 |

## 测试和覆盖率

运行完整验证：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm coverage
pnpm build
```

Phase 1 测试补强后的当前覆盖率：

| 指标 | 覆盖率 |
| --- | --- |
| Statements | 99%+ |
| Lines | 99%+ |
| Functions | 99%+ |
| Branches | 90%+ |

测试覆盖 shared contracts、server domain services、HTTP routes、WebSocket gateway、Bot SDK dispatch/reconnect、第一方 Bot、Signal facade、Web stores/components、Electron security config 和 TUI commands。

## API 概览

HTTP API 挂载在 `/api/v1` 下。受保护路由使用 `Authorization: Bearer <accessToken>`。

| 模块 | Routes |
| --- | --- |
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` |
| Workspaces | `POST /workspaces`, `GET /workspaces`, `GET/PATCH /workspaces/:id`, member management, ownership transfer |
| Channels and DMs | Workspace channel CRUD, channel members, archive/delete, `POST /dms` |
| Messages | Send, list, edit, delete, react, forward, save |
| Attachments | Upload sessions, completion, metadata lookup, download URL creation |
| Signal/E2EE | Pre-key bundles, one-time pre-key consumption, session storage |
| Bots | Install, add/remove from channels, subscriptions, bot messages, command invocation |
| Ops | `GET /healthz`, `GET /metrics` |

WebSocket client events 包括 `message.send`、`message.ack`、`typing.start`、`typing.stop`、`presence.update`、`bot.command.invoke`。Server events 包括 `message.created`、`message.updated`、`message.deleted`、`message.reaction`、`message.read`、`presence.updated`、`typing.updated` 和 Bot responses。

## Bot 框架

Bot 通过 manifest 安装并获取 opaque token。Bot 可以订阅事件、加入普通频道，并在拥有 `messages:write` scope 时发送消息。Bot 会被 E2EE 频道拒绝。

示例 manifest：

```ts
const manifest = {
  id: "bot-help",
  name: "HelpBot",
  description: "Shows available commands.",
  commands: [{ name: "/help", description: "Show command help." }],
  scopes: ["commands:handle", "messages:write"]
};
```

Node.js SDK 暴露：

```ts
bot.onCommand("/help", async (event) => {});
bot.onEvent("message.created", async (event) => {});
bot.use(async (event, next) => { await next(); });
await bot.sendMessage({ workspaceId, channelId, clientMsgId, content });
```

详见 [docs/sdk/nodejs.md](docs/sdk/nodejs.md) 和 `packages/bot-sdk`。

## E2EE 模型

Nexus Chat 使用混合模型。

| 模式 | 行为 |
| --- | --- |
| 普通频道 | 服务端明文消息内容、Bot 访问、未来服务端搜索、完整工作流支持。 |
| E2EE channels/DMs | 只接受 ciphertext 消息内容、无 Bot 访问、read-once/TTL tombstones、无服务端明文处理。 |

Phase 1 提供服务边界和本地 Signal 风格测试流程。Group E2EE、safety numbers、多设备支持和完整生产级 key management 将在后续阶段实现。

## TUI/CLI

以开发模式运行 CLI：

```bash
pnpm --filter @nexus-chat/tui dev -- --help
```

常用命令：

```bash
pnpm --filter @nexus-chat/tui dev -- login -e ada@example.com -p 'Password12345!'
pnpm --filter @nexus-chat/tui dev -- whoami
pnpm --filter @nexus-chat/tui dev -- workspaces
pnpm --filter @nexus-chat/tui dev -- channels -w <workspace-id>
pnpm --filter @nexus-chat/tui dev -- send -w <workspace-id> -c <channel-id> -m '/help'
pnpm --filter @nexus-chat/tui dev -- bot-smoke
pnpm --filter @nexus-chat/tui dev -- e2e-smoke
```

CLI 会把本地 access token 存在 `.env.tui`，该文件已被 Git ignore。

## 配置

复制 `.env.example` 到 `.env` 并按需调整。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `4000` | HTTP/WebSocket server port。 |
| `WEB_ORIGIN` | `http://localhost:5173` | Web client CORS origin。 |
| `DATABASE_URL` | local PostgreSQL URL | Drizzle migration 和 seed database。 |
| `REDIS_URL` | `redis://localhost:6379` | Redis URL，用于 Redis session/future queue/cache。 |
| `SESSION_STORE` | `memory` | Refresh session backend。使用 `redis` 可测试 Redis session storage。 |
| `JWT_ISSUER` | `nexus-chat` | JWT issuer。 |
| `JWT_AUDIENCE` | `nexus-chat-clients` | JWT audience。 |
| `JWT_PRIVATE_KEY_PEM` | empty | 可选 RS256 private key；为空时本地生成 keypair。 |
| `JWT_PUBLIC_KEY_PEM` | empty | 可选 RS256 public key；为空时本地生成 keypair。 |
| `JWT_KID` | `local-dev` | JWT key ID。 |
| `LOG_LEVEL` | `info` | Pino log level。 |
| `VITE_API_BASE` | `http://localhost:4000` | Web client API base URL。 |

不要提交真实 `.env` 或 `.env.tui` 文件。

## 文档

- [Quick Start](QUICKSTART.md)
- [中文快速开始](QUICKSTART.zh-CN.md)
- [Architecture documents](docs/design/)
- [Research notes](docs/research/)
- [Phase 1 tasks](docs/tasks/)
- [SDK docs](docs/sdk/)
- [Known limitations](docs/known-limitations.md)
- [Closed beta checklist](docs/beta-checklist.md)
- [Backup and restore](docs/backup-restore.md)

## 已知限制

部署前请阅读 [docs/known-limitations.md](docs/known-limitations.md)。最重要的 Phase 1 限制包括：

- Runtime services 默认使用内存 store。
- PostgreSQL schema 和 migrations 已存在，但 domain services 尚未完全接入 PostgreSQL 持久化。
- E2EE 是单设备边界，暂不支持 group Sender Key。
- Bot 按设计不能进入 E2EE 频道。
- Attachment backend primitives 已存在，但 Web/Desktop 上传 UX 尚未完成。
- Electron 生产签名、公证和 auto-update 发布尚未配置。

## 贡献

本项目遵循 `AGENTS.md` 中的仓库约定。

- Canonical 文档、代码注释、commit message 和 README 内容使用英文。
- 保持 TypeScript strict，避免无理由使用 `any`。
- 使用 Zod 验证运行时边界。
- 使用 Conventional Commits，例如 `feat:`、`fix:`、`docs:`、`test:`、`chore:`。
- 提 PR 前运行 `pnpm lint`、`pnpm typecheck` 和 `pnpm test`。

## License

MIT。详见 [LICENSE](LICENSE)。
