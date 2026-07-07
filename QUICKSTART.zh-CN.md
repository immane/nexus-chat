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
WEB_ORIGIN=http://localhost
DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus_chat
REDIS_URL=redis://localhost:6379
SESSION_STORE=memory
VITE_API_BASE=http://localhost:4000
```

如果希望本地测试 refresh session 存到 Redis，可以设置 `SESSION_STORE=redis`。

## 4. 启动本地 Server 容器

```bash
docker compose build server
docker compose up -d
```

确认 server 运行中：

```bash
docker compose ps
curl http://localhost:4000/healthz
```

Phase 1 运行时服务使用内存 domain stores。`docker-compose.yml` 里的 PostgreSQL 和 Redis 目前故意保持注释，直到持久化接入后再启用。

## 5. 写入内存开发数据

```bash
bash scripts/dev-bootstrap.sh
```

开发账号：

| Email | Password |
| --- | --- |
| `alice@dev.local` | `test1234abcd` |
| `bob@dev.local` | `test1234abcd` |

bootstrap 会创建 `Dev Workspace`、默认 `#general` channel，并把 Bob 加入 workspace/channel。因为当前是内存 store，每次重启或重建 server 容器后都需要重新执行。

## 6. 启动开发服务

如果使用 Docker server + Web UI，保持 server 容器运行，然后单独启动 Vite：

```bash
pnpm --filter @nexus-chat/web dev
```

如果要运行 native all-app 开发流，先停止 Docker，避免占用 `4000` 端口：

```bash
docker compose down
pnpm dev
```

打开：

- Web client: Web dev server 输出的 Vite URL，通常是 `http://localhost:5173` 或 `http://localhost:5174`
- API health check: `http://localhost:4000/healthz`
- Metrics: `http://localhost:4000/metrics`

Web app 支持 demo 模式和真实服务端模式。真实服务端模式可以使用上面的开发账号，也可以通过 API/UI 注册新用户。

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
pnpm --filter @nexus-chat/tui dev --help
```

登录本地服务：

```bash
pnpm --filter @nexus-chat/tui dev login -e alice@dev.local -p test1234abcd
```

列出工作区：

```bash
pnpm --filter @nexus-chat/tui dev workspaces
```

运行 smoke tests：

```bash
pnpm --filter @nexus-chat/tui dev api-smoke
pnpm --filter @nexus-chat/tui dev p2p-smoke
pnpm --filter @nexus-chat/tui dev bot-smoke
pnpm --filter @nexus-chat/tui dev e2e-smoke
```

运行完整 native CI smoke：

```bash
docker compose down
pnpm smoke:tui:ci
```

`smoke:tui:ci` 会自己启动 native server 并绑定 `4000`，因此 Docker 不能同时占用该端口。

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
pnpm --filter @nexus-chat/tui dev --help
```

## 10. 常用重置命令

停止基础设施：

```bash
docker compose down
```

重建内存 Docker server 并重新写入开发数据：

```bash
docker compose down
docker compose build server
docker compose up -d
bash scripts/dev-bootstrap.sh
```

清除 TUI auth token：

```bash
pnpm --filter @nexus-chat/tui dev logout
```

## 故障排查

如果 `pnpm dev` 或 `smoke:tui:ci` 端口绑定失败，检查是否已有进程占用 `4000`、`5173` 或 `5174`。运行 native CI smoke 前先用 `docker compose down` 停止 Docker server。

如果 TUI 登录失败，确认 server 正在运行，并且当前运行时存在对应用户。因为 Phase 1 默认使用内存 store，每次 fresh server 启动后需要执行 `scripts/dev-bootstrap.sh`，或者手动注册用户。

如果 `pnpm db:migrate` 失败，请注意默认 Docker 流程不会启动 PostgreSQL。只有在验证 migrations 时，才需要先取消注释 `docker-compose.yml` 里的 PostgreSQL。

如果 WebSocket 命令失败，确认 server 可通过 `VITE_API_BASE` 访问。默认 `WEB_ORIGIN=http://localhost` 会允许 browser client 使用任意 localhost 端口。

## 下一步

- 阅读完整 [README.zh-CN.md](README.zh-CN.md)。
- 查看 [docs/known-limitations.md](docs/known-limitations.md)。
- 浏览 [docs/design/](docs/design/) 下的架构文档。
- 查看 Bot SDK 文档 [docs/sdk/nodejs.md](docs/sdk/nodejs.md)。
