# Nexus Chat 快速开始

[English Quick Start](QUICKSTART.md) | [完整中文 README](README.zh-CN.md)

本指南用于在本地启动 Nexus Chat Phase 1 开发环境，并运行基础 smoke tests。

## 1. 前置要求

先安装：

- Node.js 22 或更新版本。
- pnpm 9.15.x。
- Docker Desktop 或 Docker Engine。

检查版本：

```bash
node --version
pnpm --version
docker --version
```

## 2. 安装依赖

```bash
pnpm install
```

## 3. 创建本地环境文件

```bash
cp .env.example .env
```

默认配置适合本地开发：

```env
PORT=4000
WEB_ORIGIN=http://localhost:5173
DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus_chat
REDIS_URL=redis://localhost:6379
SESSION_STORE=memory
VITE_API_BASE=http://localhost:4000
```

如果希望本地测试 refresh session 存到 Redis，可以设置 `SESSION_STORE=redis`。

## 4. 启动 PostgreSQL 和 Redis

```bash
docker compose up -d
```

确认容器运行中：

```bash
docker compose ps
```

## 5. 应用 Migrations 并写入 Seed 数据

```bash
pnpm db:migrate
pnpm db:seed
```

Seed 账号：

| Email | Password |
| --- | --- |
| `ada@example.com` | `Password12345!` |
| `grace@example.com` | `Password12345!` |

注意：Phase 1 运行时服务默认使用内存 domain stores。PostgreSQL schema、migration 和 seed 流程仍用于本地基础设施验证，并为后续持久化集成做准备。

## 6. 启动开发服务

```bash
pnpm dev
```

打开：

- Web client: `http://localhost:5173`
- API health check: `http://localhost:4000/healthz`
- Metrics: `http://localhost:4000/metrics`

Web app 支持 demo 模式和真实服务端模式。如果使用真实服务端模式，并且内存运行时里还没有用户，可以在 UI 中注册，或通过 API 注册。

## 7. 运行快速验证

另开一个 shell：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm coverage
```

预期结果：全部通过。当前 coverage 超过 99% statement coverage，并超过 90% branch coverage。

## 8. 试用 TUI/CLI

查看帮助：

```bash
pnpm --filter @nexus-chat/tui dev -- --help
```

登录本地服务：

```bash
pnpm --filter @nexus-chat/tui dev -- login -e ada@example.com -p 'Password12345!'
```

列出工作区：

```bash
pnpm --filter @nexus-chat/tui dev -- workspaces
```

运行 smoke tests：

```bash
pnpm --filter @nexus-chat/tui dev -- bot-smoke
pnpm --filter @nexus-chat/tui dev -- e2e-smoke
```

CLI 会把本地 token 存到 `.env.tui`，该文件已被 Git ignore。

## 9. 单独运行各应用

只运行 server：

```bash
pnpm --filter @nexus-chat/server dev
```

只运行 web：

```bash
pnpm --filter @nexus-chat/web dev
```

运行 desktop shell：

```bash
pnpm --filter @nexus-chat/desktop dev
```

运行 TUI/CLI：

```bash
pnpm --filter @nexus-chat/tui dev -- --help
```

## 10. 常用重置命令

停止基础设施：

```bash
docker compose down
```

删除 PostgreSQL 数据并重新创建：

```bash
docker compose down -v
docker compose up -d
pnpm db:migrate
pnpm db:seed
```

清除 TUI auth token：

```bash
pnpm --filter @nexus-chat/tui dev -- logout
```

## 故障排查

如果 `pnpm dev` 端口绑定失败，检查是否已有进程占用 `4000` 或 `5173`。

如果 TUI 登录失败，确认 server 正在运行，并且当前运行时存在对应用户。因为 Phase 1 默认使用内存 store，PostgreSQL seed 用户不会自动加载到内存 auth store。

如果 `pnpm db:migrate` 失败，确认 Docker 正在运行，并且 `DATABASE_URL` 指向本地 PostgreSQL 容器。

如果 WebSocket 命令失败，确认 web origin 与 `WEB_ORIGIN` 匹配，并且 server 可通过 `VITE_API_BASE` 访问。

## 下一步

- 阅读完整 [README.zh-CN.md](README.zh-CN.md)。
- 查看 [docs/known-limitations.md](docs/known-limitations.md)。
- 浏览 [docs/design/](docs/design/) 下的架构文档。
- 查看 Bot SDK 文档 [docs/sdk/nodejs.md](docs/sdk/nodejs.md)。
