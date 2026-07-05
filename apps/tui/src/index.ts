#!/usr/bin/env node
import { createProgram } from "./cli.js";

export { createProgram } from "./cli.js";
export { getAccessToken, setAccessToken, clearAccessToken, request } from "./lib/api.js";
export { createSocket, sendMessage, listenForMessages } from "./lib/ws-client.js";
export { runE2eSmoke, runBotSmoke, runApiSmoke, runP2pSmoke } from "./commands/smoke.js";
export const startInteractiveChat = async (...args: [string?, string?]) => {
  const { startInteractiveChat: fn } = await import("./app.js");
  return fn(...args);
};

const isMain = process.argv[1]?.includes("index");
if (isMain) {
  const program = createProgram();
  await program.parseAsync(process.argv);
}
