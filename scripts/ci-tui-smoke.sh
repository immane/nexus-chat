#!/usr/bin/env bash
set -euo pipefail

export NEXUS_API_BASE="${NEXUS_API_BASE:-http://127.0.0.1:4000}"
export LOG_LEVEL="${LOG_LEVEL:-silent}"

server_log="${RUNNER_TEMP:-/tmp}/nexus-chat-server.log"

pnpm --filter @nexus-chat/server dev >"$server_log" 2>&1 &
server_pid=$!

cleanup() {
  kill "$server_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

node --input-type=module <<'NODE'
const base = process.env.NEXUS_API_BASE ?? "http://127.0.0.1:4000";
const started = Date.now();
let lastError;

while (Date.now() - started < 30000) {
  try {
    const response = await fetch(`${base}/healthz`);
    if (response.ok) process.exit(0);
    lastError = new Error(`HTTP ${response.status}`);
  } catch (error) {
    lastError = error;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

throw new Error(`Server did not become healthy: ${String(lastError)}`);
NODE

node --input-type=module <<'NODE'
const base = process.env.NEXUS_API_BASE ?? "http://127.0.0.1:4000";
const response = await fetch(`${base}/api/v1/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: "alice@t.local",
    password: "test1234abcd",
    displayName: "Alice Smoke"
  })
});

const json = await response.json();
if (!json.ok && json.error?.code !== "CONFLICT") {
  throw new Error(`Seed user failed: ${JSON.stringify(json)}`);
}
NODE

pnpm smoke:tui
