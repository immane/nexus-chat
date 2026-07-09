#!/usr/bin/env node
/**
 * TUI Entry Point — Nexus Chat Terminal Client
 *
 * Responsibilities:
 * - Re-exports the full TUI public API (CLI program, HTTP client, WS client, smoke tests)
 * - Lazy-loads the Ink interactive chat app to avoid importing React in non-interactive CLI mode
 * - Acts as the Commander.js binary entry point when invoked directly
 *
 * Inputs:
 * - `process.argv` — CLI arguments parsed by Commander
 * - `NEXUS_API_BASE` env var — API server URL
 * - `.env.tui` file — persisted access token
 *
 * Outputs:
 * - Commander CLI (stdout/stderr)
 * - Ink-based interactive TUI (terminal rendering)
 *
 * Forbidden Dependencies:
 * - Must NOT import `app.tsx` statically (it pulls in React/Ink, bloating non-interactive CLI commands)
 * - Must NOT access server-side modules directly
 */
import { createProgram } from "./cli.js";

export { createProgram } from "./cli.js";
export { getAccessToken, setAccessToken, clearAccessToken, request } from "./lib/api.js";
export { createSocket, sendMessage, listenForMessages } from "./lib/ws-client.js";
export { runE2eSmoke, runBotSmoke, runApiSmoke, runP2pSmoke } from "./commands/smoke.js";

/** Starts the interactive Ink chat UI. Lazy-imports app.tsx to keep React/Ink out of non-interactive CLI commands. */
export const startInteractiveChat = async () => {
  const { startInteractiveChat: fn } = await import("./app.js");
  return fn();
};

const isMain = process.argv[1]?.includes("index");
if (isMain) {
  const program = createProgram();
  await program.parseAsync(process.argv);
}