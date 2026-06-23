---
lang: en
phase: 1
status: draft
---

# 14 — Phase 1 — Electron Shell, IPC Boundary & Desktop Integration

## Goal

Build the minimal secure Electron desktop shell that loads the React app and provides native desktop integration without leaking Node.js privileges to the renderer.

## Scope

- Electron main process.
- Preload script with `contextBridge`.
- Main BrowserWindow.
- App lifecycle.
- System tray.
- Native notifications.
- Secure IPC channels.
- Basic auto-update hooks or placeholders.
- Dev/prod Vite loading.

## Non-Goals

- No advanced multi-window system.
- No screen share.
- No native call controls.
- No production notarization in initial task.

## Security Requirements

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true` where compatible.
- Strict preload API allowlist.
- No direct filesystem access from renderer.

## Preload API

| API | Purpose |
|-----|---------|
| `app.getVersion()` | Display app version |
| `notifications.show()` | Native notifications |
| `window.minimize/maximize/close()` | Window controls |
| `clipboard.writeText()` | Copy message links/text |

## Acceptance Criteria

- Electron launches React app in dev.
- Electron loads built assets in prod.
- Tray menu works.
- Native notification can be triggered through preload API.
- Renderer cannot access Node.js APIs directly.

## Test Plan

- Smoke test Electron launch.
- IPC contract unit tests.
- Security config check.
- Manual notification test.

## Dependencies

- [01 — Project Scaffold](01-phase-1-project-scaffold.md)
- [13 — Web Client Shell](13-phase-1-web-client-shell.md)
