import { Command } from "commander";
import { request, clearAccessToken } from "./lib/api.js";
import { createSocket, sendMessage, sendBotCommand } from "./lib/ws-client.js";
import { runE2eSmoke, runBotSmoke, runApiSmoke, runP2pSmoke, login as smokeLogin } from "./commands/smoke.js";

export function createProgram(): Command {
  const program = new Command();
  program.name("nexus").description("Nexus Chat TUI/CLI").version("0.1.0");

  program
    .command("login")
    .description("Authenticate and persist access token to .env.tui")
    .requiredOption("-e, --email <email>")
    .requiredOption("-p, --password <password>")
    .option("-s, --server <url>", "API server URL")
    .action(async (options: { email: string; password: string; server?: string }) => {
      try {
        if (options.server) process.env.NEXUS_API_BASE = options.server;
        await smokeLogin(options.email, options.password);
        console.log("Logged in. Token saved to .env.tui");
      } catch (err) {
        process.exitCode = 1;
        console.error("Login failed:", String(err));
      }
    });

  program
    .command("logout")
    .description("Clear persisted access token")
    .action(() => {
      clearAccessToken();
      console.log("Logged out. Token cleared from .env.tui");
    });

  program
    .command("whoami")
    .description("Show current authenticated user")
    .action(async () => {
      try {
        const user = await request<Record<string, unknown>>("/api/v1/auth/me");
        console.log(JSON.stringify(user, null, 2));
      } catch (err) {
        process.exitCode = 1;
        console.error(String(err));
      }
    });

  program
    .command("workspaces")
    .description("List workspaces")
    .action(async () => {
      try {
        const list = await request<unknown[]>("/api/v1/workspaces");
        console.log(JSON.stringify(list, null, 2));
      } catch (err) {
        process.exitCode = 1;
        console.error(String(err));
      }
    });

  program
    .command("workspace-create")
    .description("Create a new workspace")
    .requiredOption("-n, --name <name>")
    .action(async (options: { name: string }) => {
      try {
        const ws = await request<Record<string, unknown>>("/api/v1/workspaces", {
          method: "POST",
          body: JSON.stringify({ name: options.name })
        });
        console.log(JSON.stringify(ws, null, 2));
      } catch (err) {
        process.exitCode = 1;
        console.error(String(err));
      }
    });

  program
    .command("channels")
    .description("List channels in a workspace")
    .requiredOption("-w, --workspace <id>")
    .action(async (options: { workspace: string }) => {
      try {
        const list = await request<unknown[]>(`/api/v1/workspaces/${options.workspace}/channels`);
        console.log(JSON.stringify(list, null, 2));
      } catch (err) {
        process.exitCode = 1;
        console.error(String(err));
      }
    });

  program
    .command("channel-create")
    .description("Create a channel in a workspace")
    .requiredOption("-w, --workspace <id>")
    .requiredOption("-n, --name <name>")
    .option("--e2e", "Create an E2E encrypted channel")
    .action(async (options: { workspace: string; name: string; e2e?: boolean }) => {
      try {
        const ch = await request<Record<string, unknown>>(`/api/v1/workspaces/${options.workspace}/channels`, {
          method: "POST",
          body: JSON.stringify({ name: options.name, mode: options.e2e ? "e2e" : "normal" })
        });
        console.log(JSON.stringify(ch, null, 2));
      } catch (err) {
        process.exitCode = 1;
        console.error(String(err));
      }
    });

  program
    .command("chat")
    .description("Start interactive chat UI (Ink)")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("-c, --channel <id>", "Channel ID")
    .action(async (options: { workspace?: string; channel?: string }) => {
      const { startInteractiveChat } = await import("./app.js");
      await startInteractiveChat(options.workspace, options.channel);
    });

  program
    .command("read")
    .description("Read messages from a channel (non-interactive)")
    .requiredOption("-c, --channel <id>")
    .option("-l, --limit <n>", "Max messages", "50")
    .action(async (options: { channel: string; limit: string }) => {
      try {
        const result = await request<unknown>(`/api/v1/channels/${options.channel}/messages?limit=${Number(options.limit)}`);
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        process.exitCode = 1;
        console.error(String(err));
      }
    });

  program
    .command("send")
    .description("Send a message via WebSocket")
    .requiredOption("-w, --workspace <id>")
    .requiredOption("-c, --channel <id>")
    .requiredOption("-m, --message <text>")
    .action(async (options: { workspace: string; channel: string; message: string }) => {
      try {
        const socket = createSocket();
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
          socket.on("connect", () => { clearTimeout(timeout); resolve(); });
          socket.connect();
        });

        const text = options.message;
        const isSlash = text.startsWith("/");
        const [cmd, ...args] = isSlash ? text.split(/\s+/) : ["", []];
        let result: { ok: boolean; data?: unknown; error?: { code: string; message: string } };

        if (isSlash && cmd) {
          result = await sendBotCommand(socket, options.workspace, options.channel, cmd, args as string[]);
        } else {
          const input = {
            workspaceId: options.workspace,
            channelId: options.channel,
            clientMsgId: `tui-cli-${Date.now()}`,
            content: { type: "text" as const, text, attachments: [] }
          };
          result = await sendMessage(socket, input);
        }
        socket.disconnect();

        if (!result.ok) {
          process.exitCode = 1;
          console.error(`Send failed: ${result.error?.message ?? "unknown"}`);
        } else {
          console.log(JSON.stringify(result.data, null, 2));
        }
      } catch (err) {
        process.exitCode = 1;
        console.error(String(err));
      }
    });

  program
    .command("e2e-smoke")
    .description("End-to-end E2EE smoke test: identity creation, encryption, send, decrypt")
    .action(async () => {
      try {
        await runE2eSmoke();
      } catch (err) {
        process.exitCode = 1;
        console.error("e2e smoke failed:", String(err));
      }
    });

  program
    .command("bot-smoke")
    .description("Bot smoke test: install help bot, invoke /help")
    .action(async () => {
      try {
        await runBotSmoke();
      } catch (err) {
        process.exitCode = 1;
        console.error("bot smoke failed:", String(err));
      }
    });

  program
    .command("api-smoke")
    .description("API smoke test: exercise all core REST endpoints")
    .action(async () => {
      try {
        await runApiSmoke();
      } catch (err) {
        process.exitCode = 1;
        console.error("api smoke failed:", String(err));
      }
    });

  program
    .command("p2p-smoke")
    .description("P2P smoke test: verify schemas and server signaling relay")
    .action(async () => {
      try {
        await runP2pSmoke();
      } catch (err) {
        process.exitCode = 1;
        console.error("p2p smoke failed:", String(err));
      }
    });

  return program;
}
