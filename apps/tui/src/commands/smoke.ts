import {
  createLocalSignalIdentity,
  toPreKeyBundle,
  establishSession,
  encryptForSession,
  decryptFromSession,
  createInMemorySignalSessionStore
} from "@nexus-chat/signal";
import type { SendMessageInput } from "@nexus-chat/shared";
import { request, getAccessToken, setAccessToken } from "../lib/api.js";
import { createSocket, sendMessage, sendBotCommand } from "../lib/ws-client.js";

export const login = async (email: string, password: string) => {
  const session = await request<{ accessToken?: string; tokens?: { accessToken: string } }>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  const at = session.accessToken ?? session.tokens?.accessToken ?? "";
  if (!at) throw new Error("No access token in login response");
  setAccessToken(at);
  return at;
};

export const runE2eSmoke = async () => {
  const token = getAccessToken();
  if (!token) throw new Error("Not authenticated. Run 'nexus login' first.");

  const ts = Date.now();

  const getData = (resp: unknown): { token: string; userId: string } => {
    const s = resp as { accessToken?: string; tokens?: { accessToken: string }; user?: { id: string } };
    return { token: s.accessToken ?? s.tokens?.accessToken ?? "", userId: s.user?.id ?? "" };
  };

  // Register both users
  let aliceUserId = "";
  let aliceToken = "";
  let bobUserId = "";
  let bobToken = "";
  try {
    const as = await request<unknown>("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: `alice-e2e-${ts}@smoke.local`, password: "testteste2e12", displayName: "Alice" })
    });
    const d = getData(as);
    aliceToken = d.token;
    aliceUserId = d.userId;
  } catch { /* user may exist */ }

  try {
    const bs = await request<unknown>("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: `bob-e2e-${ts}@smoke.local`, password: "testteste2e12", displayName: "Bob" })
    });
    const d = getData(bs);
    bobToken = d.token;
    bobUserId = d.userId;
  } catch { /* user may exist */ }

  if (!aliceToken || !bobToken || !aliceUserId || !bobUserId) {
    process.exitCode = 1;
    console.error("e2e smoke failed: could not obtain tokens");
    return;
  }

  // Create identities using actual user IDs
  const alice = createLocalSignalIdentity(aliceUserId, "device-01", 5);
  const bob = createLocalSignalIdentity(bobUserId, "device-01", 5);

  // Alice uploads her own prekey bundle
  const bundle = toPreKeyBundle(alice);
  await request("/api/v1/signal/prekey-bundles", {
    method: "POST",
    headers: { authorization: `Bearer ${aliceToken}` },
    body: JSON.stringify(bundle)
  });

  // Bob fetches Alice's bundle
  const fetched = await request<Record<string, unknown>>(`/api/v1/signal/prekey-bundles/${alice.userId}/${alice.deviceId}`, {
    headers: { authorization: `Bearer ${bobToken}` }
  });

  // Establish session
  const sessionStore = createInMemorySignalSessionStore();
  const session = establishSession(bob, { ...fetched, userId: alice.userId, deviceId: alice.deviceId } as never, sessionStore);

  // Encrypt a read-once message
  const { ciphertext } = await encryptForSession(session, "secret e2e smoke message");
  if (!ciphertext || ciphertext.length < 4) {
    process.exitCode = 1;
    console.error("e2e smoke failed: encryption produced empty ciphertext");
    return;
  }

  // Decrypt
  const decrypted = await decryptFromSession(session, ciphertext);
  if (decrypted !== "secret e2e smoke message") {
    process.exitCode = 1;
    console.error(`e2e smoke failed: decryption mismatch, got "${decrypted}"`);
    return;
  }

  // Send encrypted message via WebSocket
  const wsInput: SendMessageInput = {
    workspaceId: "smoke-ws",
    channelId: "smoke-ch",
    clientMsgId: `e2e-smoke-${Date.now()}`,
    content: { type: "ciphertext", ciphertext, algorithm: "signal-v1", senderDeviceId: "device-01", readOnce: true, attachments: [] }
  };

  const socket = createSocket();
  socket.auth = { token: bobToken };
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
    socket.on("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.connect();
  });

  // Create workspace and channel for Bob
  const ws = await request<{ id: string }>("/api/v1/workspaces", {
    method: "POST",
    headers: { authorization: `Bearer ${bobToken}` },
    body: JSON.stringify({ name: "E2E Smoke Workspace" })
  });

  const ch = await request<{ id: string }>(`/api/v1/workspaces/${ws.id}/channels`, {
    method: "POST",
    headers: { authorization: `Bearer ${bobToken}` },
    body: JSON.stringify({ name: "e2e-smoke", mode: "e2e" })
  });

  wsInput.workspaceId = ws.id;
  wsInput.channelId = ch.id;

  const result = await sendMessage(socket, wsInput);
  socket.disconnect();

  if (!result.ok) {
    process.exitCode = 1;
    console.error(`e2e smoke failed: ${result.error?.message ?? "unknown error"}`);
    return;
  }

  console.log("e2e smoke ok");
};

export const runBotSmoke = async () => {
  const token = getAccessToken();
  if (!token) throw new Error("Not authenticated. Run 'nexus login' first.");

  // Verify auth works
  await request<{ id: string }>("/api/v1/auth/me");

  // Create workspace + channel
  const ws = await request<{ id: string }>("/api/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: "Bot Smoke Workspace" })
  });

  const ch = await request<{ id: string }>(`/api/v1/workspaces/${ws.id}/channels`, {
    method: "POST",
    body: JSON.stringify({ name: "bot-smoke", mode: "normal" })
  });

  // Install help bot
  await request(`/api/v1/bots/install?workspaceId=${encodeURIComponent(ws.id)}`, {
    method: "POST",
    body: JSON.stringify({
      id: "bot-help-smoke",
      name: "help",
      description: "Help smoke bot",
      commands: [{ name: "/help", description: "List commands" }],
      scopes: ["commands:handle", "messages:write"]
    })
  });

  // Connect WS and send bot command
  const socket = createSocket();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
    socket.on("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.connect();
  });

  const result = await sendBotCommand(socket, ws.id, ch.id, "/help", []);
  socket.disconnect();

  if (!result.ok) {
    process.exitCode = 1;
    console.error(`bot smoke failed: ${result.error?.message ?? "unknown error"}`);
    return;
  }

  console.log("bot smoke ok");
};
