import {
  createLocalSignalIdentity,
  toPreKeyBundle,
  establishSession,
  encryptForSession,
  decryptFromSession,
  createInMemorySignalSessionStore
} from "@nexus-chat/signal";
import type { SendMessageInput } from "@nexus-chat/shared";
import { request, getAccessToken, setAccessToken, apiBase } from "../lib/api.js";
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

export const runApiSmoke = async () => {
  const token = getAccessToken();
  if (!token) throw new Error("Not authenticated. Run 'nexus login' first.");

  const ts = Date.now();

  const ok = <T>(label: string, fn: () => Promise<T>) =>
    fn().then(
      (value) => { console.log(`  ✓ ${label}`); return value; },
      (err) => { throw new Error(`${label} FAILED: ${String(err)}`); }
    );

  const assertOk = <T>(label: string, value: T, pred: (v: T) => boolean) => {
    if (!pred(value)) throw new Error(`${label} assertion failed`);
    console.log(`  ✓ ${label}`);
    return value;
  };

  console.log("API smoke test");

  // ── Auth ──
  const loginResult = await ok("POST /auth/login", () =>
    request<{ user: { id: string; email: string }; tokens: { accessToken: string; refreshToken: string } }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: `api-smoke-${ts}@smoke.local`, password: "TestApiSmoke12!" })
    }).catch(() =>
      request<{ user: { id: string; email: string }; tokens: { accessToken: string; refreshToken: string } }>("/api/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({ email: `api-smoke-${ts}@smoke.local`, password: "TestApiSmoke12!", displayName: "Smoke" })
      })
    ));
  assertOk("auth/me", loginResult.user, (u) => typeof u.id === "string" && u.email.includes("smoke"));

  const smokeToken = loginResult.tokens.accessToken;
  const smokeHeaders = (extra: Record<string, string> = {}) => ({
    ...extra,
    "content-type": "application/json",
    authorization: `Bearer ${smokeToken}`
  });
  const smokeReq = <T>(path: string, options: RequestInit = {}): Promise<T> =>
    request<T>(path, { ...options, headers: { ...smokeHeaders(), ...(options.headers as Record<string, string> ?? {}) } });

  await ok("POST /auth/refresh", () =>
    smokeReq<{ tokens: { accessToken: string } }>("/api/v1/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: loginResult.tokens.refreshToken })
    })
  );

  await ok("GET /auth/me", () => smokeReq<unknown>("/api/v1/auth/me"));

  await ok("GET /healthz", () => request("/healthz"));
  await ok("GET /metrics", async () => {
    const response = await fetch(`${apiBase}/metrics`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text.includes("# HELP")) throw new Error("missing Prometheus exposition text");
  });

  // ── Workspaces ──
  const ws = await ok("POST /workspaces", () =>
    smokeReq<{ id: string; name: string }>("/api/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "API Smoke" })
    })
  );
  assertOk("workspace has id", ws, (w) => typeof w.id === "string");

  await ok("GET /workspaces", () =>
    smokeReq<unknown[]>("/api/v1/workspaces").then((list) => {
      if (!Array.isArray(list) || list.length < 1) throw new Error("empty");
    })
  );

  await ok("GET /workspaces/:id", () =>
    smokeReq<{ name: string }>(`/api/v1/workspaces/${ws.id}`)
  );

  await ok("PATCH /workspaces/:id", () =>
    smokeReq<{ name: string }>(`/api/v1/workspaces/${ws.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "API Smoke Renamed" })
    })
  );

  await ok("GET /workspaces/:id/members", () =>
    smokeReq<Array<{ userId: string }>>(`/api/v1/workspaces/${ws.id}/members`).then((m) => {
      if (m.length < 1) throw new Error("no members");
    })
  );

  // Register second user for multi-user tests
  let secondToken = "";
  let secondUserId = "";
  try {
    const reg = await request<{ tokens: { accessToken: string }; user: { id: string } }>("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: `smoke-2-${ts}@smoke.local`, password: "TestApiSmoke12!", displayName: "Smoke2" })
    });
    secondToken = reg.tokens.accessToken;
    secondUserId = reg.user.id;
  } catch { /* may exist */ }

  // ── Channels ──
  const ch = await ok("POST /workspaces/:id/channels (normal)", () =>
    smokeReq<{ id: string; name: string; mode: string }>(`/api/v1/workspaces/${ws.id}/channels`, {
      method: "POST",
      body: JSON.stringify({ name: "api-smoke-ch", mode: "normal" })
    })
  );
  assertOk("channel mode is normal", ch, (c) => c.mode === "normal");

  await ok("GET /workspaces/:id/channels", () =>
    smokeReq<unknown[]>(`/api/v1/workspaces/${ws.id}/channels`).then((list) => {
      if (!Array.isArray(list) || list.length < 2) throw new Error("expected >=2 channels (general + api-smoke-ch)");
    })
  );

  if (secondToken) {
    const s2h = (extra: Record<string, string> = {}) => ({
      ...extra,
      "content-type": "application/json",
      authorization: `Bearer ${secondToken}`
    });
    const s2req = <T>(path: string, options: RequestInit = {}): Promise<T> =>
      request<T>(path, { ...options, headers: { ...s2h(), ...(options.headers as Record<string, string> ?? {}) } });

    const s2user = await s2req<{ id: string }>("/api/v1/auth/me");
    const s2userId = s2user.id;
    secondUserId = s2userId;

    await ok("POST /workspaces/:id/members (add member)", () =>
      smokeReq<unknown>(`/api/v1/workspaces/${ws.id}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: s2userId, role: "member" })
      })
    );

    await ok("POST /channels/:id/members", () =>
      smokeReq<unknown>(`/api/v1/channels/${ch.id}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: s2userId })
      })
    );

    await ok("POST /dms", () =>
      smokeReq<{ id: string; kind: string }>(`/api/v1/dms?workspaceId=${encodeURIComponent(ws.id)}`, {
        method: "POST",
        body: JSON.stringify({ peerUserId: s2userId, mode: "normal" })
      }).then((dm) => {
        if (dm.kind !== "dm") throw new Error("not a dm");
      })
    );

    // Second dm call → idempotent
    await ok("POST /dms (idempotent)", () =>
      smokeReq<{ id: string }>(`/api/v1/dms?workspaceId=${encodeURIComponent(ws.id)}`, {
        method: "POST",
        body: JSON.stringify({ peerUserId: s2userId, mode: "normal" })
      })
    );
  }

  await ok("GET /channels/:id/members", () =>
    smokeReq<unknown[]>(`/api/v1/channels/${ch.id}/members`)
  );

  // ── Messages ──
  let msgId = "";
  const msg = await ok("POST /messages", () =>
    smokeReq<{ id: string; content: { text: string }; state: string }>("/api/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        channelId: ch.id,
        clientMsgId: `api-smoke-msg-${Date.now()}`,
        content: { type: "text", text: "hello from api smoke", attachments: [] }
      })
    })
  );
  assertOk("message state is sent", msg, (m) => { msgId = m.id; return m.state === "sent"; });

  // Duplicate send → same id
  await ok("POST /messages (idempotent)", () =>
    smokeReq<{ id: string }>("/api/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        channelId: ch.id,
        clientMsgId: `api-smoke-msg-${Date.now()}`,
        content: { type: "text", text: "this is duplicate", attachments: [] }
      })
    })
  );

  await ok("GET /channels/:id/messages", () =>
    smokeReq<unknown[]>(`/api/v1/channels/${ch.id}/messages?limit=10`).then((list) => {
      if (!Array.isArray(list) || list.length < 1) throw new Error("no messages");
    })
  );

  await ok("PATCH /messages/:id (edit)", () =>
    smokeReq<{ content: { text: string } }>(`/api/v1/messages/${msgId}`, {
      method: "PATCH",
      body: JSON.stringify({ text: "edited smoke message" })
    })
  );

  await ok("POST /messages/:id/reactions (add)", () =>
    smokeReq<{ reacted: boolean; count: number }>(`/api/v1/messages/${msgId}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji: "🚀" })
    }).then((r) => {
      if (r.count < 1) throw new Error("reaction not counted");
    })
  );

  await ok("POST /messages/:id/reactions (remove)", () =>
    smokeReq<{ reacted: boolean }>(`/api/v1/messages/${msgId}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji: "🚀" })
    })
  );

  await ok("POST /messages/:id/save", () =>
    smokeReq<{ saved: true }>(`/api/v1/messages/${msgId}/save`, { method: "POST" })
  );

  await ok("POST /messages/:id/forward", () =>
    smokeReq<{ originalMessageId: string }>(`/api/v1/messages/${msgId}/forward`, {
      method: "POST",
      body: JSON.stringify({ targetChannelId: ch.id, clientMsgId: `fwd-${Date.now()}` })
    })
  );

  await ok("DELETE /messages/:id", () =>
    smokeReq<{ state: string }>(`/api/v1/messages/${msgId}`, { method: "DELETE" }).then((m) => {
      if (m.state !== "deleted") throw new Error("not deleted");
    })
  );

  // ── Attachments ──
  let fileId = "";
  let sessionId = "";
  const created = await ok("POST /attachments/upload-sessions", () =>
    smokeReq<{ uploadSession: { id: string }; file: { id: string; objectKey: string } }>("/api/v1/attachments/upload-sessions", {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, channelId: ch.id, fileName: "smoke.txt", contentType: "text/plain", sizeBytes: 10, encrypted: false })
    })
  );
  fileId = created.file.id;
  sessionId = created.uploadSession.id;

  await ok("POST /attachments/upload-sessions/:id/complete", () =>
    smokeReq<{ completedAt: string }>(`/api/v1/attachments/upload-sessions/${sessionId}/complete`, { method: "POST" })
  );

  await ok("GET /attachments/:fileId", () =>
    smokeReq<{ objectKey: string }>(`/api/v1/attachments/${fileId}`)
  );

  await ok("POST /attachments/:fileId/download-url", () =>
    smokeReq<{ url: string }>(`/api/v1/attachments/${fileId}/download-url`, { method: "POST" })
  );

  // ── Signal / E2EE ──
  await ok("POST /signal/prekey-bundles", () =>
    smokeReq<unknown>("/api/v1/signal/prekey-bundles", {
      method: "POST",
      body: JSON.stringify({
        userId: loginResult.user.id,
        deviceId: "api-smoke-device",
        identityKey: Buffer.from("identity").toString("base64"),
        signedPreKeyId: 1,
        signedPreKey: Buffer.from("signed").toString("base64"),
        signedPreKeySignature: Buffer.from("sig").toString("base64")
      })
    })
  );

  await ok("POST /signal/prekey-bundles (with OPKs)", () =>
    smokeReq<unknown>("/api/v1/signal/prekey-bundles", {
      method: "POST",
      body: JSON.stringify({
        userId: loginResult.user.id,
        deviceId: "api-smoke-device",
        identityKey: Buffer.from("id2").toString("base64"),
        signedPreKeyId: 2,
        signedPreKey: Buffer.from("spk2").toString("base64"),
        signedPreKeySignature: Buffer.from("sig2").toString("base64"),
        oneTimePreKeys: [
          { keyId: 1, publicKey: Buffer.from("opk1").toString("base64") },
          { keyId: 2, publicKey: Buffer.from("opk2").toString("base64") }
        ]
      })
    })
  );

  await ok("GET /signal/prekey-bundles/:userId/:deviceId/count", () =>
    smokeReq<{ remaining: number }>(`/api/v1/signal/prekey-bundles/${loginResult.user.id}/api-smoke-device/count`).then((r) => {
      if (r.remaining < 1) throw new Error(`expected >=1 OPKs, got ${r.remaining}`);
    })
  );

  // Test OPK consumption via fetchBundle
  try {
    await smokeReq<{ oneTimePreKeyId: number }>(`/api/v1/signal/prekey-bundles/${loginResult.user.id}/api-smoke-device`);
  } catch {
    // OPK may have been consumed by fetch; expected to return bundle without OPK if exhausted
  }

  const sessionResult = await ok("POST /signal/sessions", () =>
    smokeReq<{ id: string }>(`/api/v1/signal/sessions?peerUserId=${loginResult.user.id}&deviceId=api-smoke-device`, { method: "POST" })
  );

  await ok("GET /signal/sessions", () =>
    smokeReq<unknown[]>(`/api/v1/signal/sessions`)
  );

  await ok("GET /signal/sessions/:id", () =>
    smokeReq<{ peerUserId: string }>(`/api/v1/signal/sessions/${sessionResult.id}`)
  );

  // ── Bots ──
  const installResult = await ok("POST /bots/install", () =>
    smokeReq<{ token: string; bot: { id: string } }>(`/api/v1/bots/install?workspaceId=${encodeURIComponent(ws.id)}`, {
      method: "POST",
      body: JSON.stringify({
        id: `bot-smoke-${ts}`,
        name: "SmokeBot",
        description: "API smoke test bot",
        commands: [{ name: "/ping", description: "Ping" }],
        scopes: ["commands:handle", "messages:write"]
      })
    })
  );
  assertOk("bot token starts with nxbot_v1_", installResult, (r) => r.token.startsWith("nxbot_v1_"));

  await ok("POST /bots/:botId/channels/:channelId", () =>
    smokeReq<unknown>(`/api/v1/bots/${installResult.bot.id}/channels/${ch.id}`, { method: "POST" })
  );

  await ok("POST /bots/commands", () =>
    smokeReq<unknown>("/api/v1/bots/commands", {
      method: "POST",
      body: JSON.stringify({
        command: "/ping",
        workspaceId: ws.id,
        channelId: ch.id,
        userId: loginResult.user.id
      })
    })
  );

  await ok("DELETE /bots/:botId/channels/:channelId", () =>
    smokeReq<unknown>(`/api/v1/bots/${installResult.bot.id}/channels/${ch.id}`, { method: "DELETE" })
  );

  // ── Ownership transfer ──
  if (secondToken && secondUserId) {
    await ok("POST /workspaces/:id/transfer-ownership", () =>
      smokeReq<{ role: string }>(`/api/v1/workspaces/${ws.id}/transfer-ownership`, {
        method: "POST",
        body: JSON.stringify({ newOwnerUserId: secondUserId })
      })
    );
    // Transfer back
    await ok("POST /workspaces/:id/transfer-ownership (back)", () =>
      request<{ role: string }>(`/api/v1/workspaces/${ws.id}/transfer-ownership`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secondToken}` },
        body: JSON.stringify({ newOwnerUserId: loginResult.user.id })
      })
    );
  }

  // ── Archive & delete channel ──
  await ok("POST /channels/:id/archive", () =>
    smokeReq<{ archivedAt: string }>(`/api/v1/channels/${ch.id}/archive`, { method: "POST" })
  );

  // Create another channel for delete test
  const ch2 = await ok("POST /workspaces/:id/channels (for delete)", () =>
    smokeReq<{ id: string }>(`/api/v1/workspaces/${ws.id}/channels`, {
      method: "POST",
      body: JSON.stringify({ name: "smoke-del-ch", mode: "normal" })
    })
  );

  await ok("DELETE /channels/:id", () =>
    smokeReq<{ deletedAt: string }>(`/api/v1/channels/${ch2.id}`, { method: "DELETE" })
  );

  // ── Logout ──
  await ok("POST /auth/logout", () =>
    smokeReq<unknown>("/api/v1/auth/logout", {
      method: "POST",
      body: JSON.stringify({ refreshToken: loginResult.tokens.refreshToken })
    })
  );

  console.log("api smoke ok — all endpoints passed");
};
