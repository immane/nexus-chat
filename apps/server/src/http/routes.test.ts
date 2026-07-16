import { beforeEach, describe, expect, it } from "vitest";
import { resetStore } from "../domain/test-utils.js";
import { authRateLimiter } from "./auth-rate-limit.js";
import { createHttpApp } from "./routes.js";

const jsonRequest = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });

const parseJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

describe("auth HTTP routes", () => {
  beforeEach(() => {
    resetStore();
    authRateLimiter.reset();
  });

  it("registers logs in refreshes logs out and guards me", async () => {
    const app = createHttpApp();
    const registeredResponse = await app.request(jsonRequest("/api/v1/auth/register", { email: "ada@example.com", password: "Password12345!", displayName: "Ada" }));
    expect(registeredResponse.status).toBe(201);
    expect(registeredResponse.headers.get("x-content-type-options")).toBe("nosniff");
    const registered = await parseJson<{ ok: true; data: { tokens: { accessToken: string; refreshToken: string } } }>(registeredResponse);

    const meResponse = await app.request(new Request("http://localhost/api/v1/auth/me", { headers: { authorization: `Bearer ${registered.data.tokens.accessToken}` } }));
    expect(meResponse.status).toBe(200);

    const refreshResponse = await app.request(jsonRequest("/api/v1/auth/refresh", { refreshToken: registered.data.tokens.refreshToken }));
    expect(refreshResponse.status).toBe(200);
    const refreshed = await parseJson<{ ok: true; data: { tokens: { refreshToken: string } } }>(refreshResponse);

    const replayResponse = await app.request(jsonRequest("/api/v1/auth/refresh", { refreshToken: registered.data.tokens.refreshToken }));
    expect(replayResponse.status).toBe(401);

    const logoutResponse = await app.request(jsonRequest("/api/v1/auth/logout", { refreshToken: refreshed.data.tokens.refreshToken }));
    expect(logoutResponse.status).toBe(200);

    const anonymousMeResponse = await app.request(new Request("http://localhost/api/v1/auth/me"));
    expect(anonymousMeResponse.status).toBe(401);
  });

  it("returns generic invalid credential errors and rate limits repeated failures", async () => {
    const app = createHttpApp();
    await app.request(jsonRequest("/api/v1/auth/register", { email: "grace@example.com", password: "Password12345!", displayName: "Grace" }));
    for (let index = 0; index < 5; index += 1) {
      const response = await app.request(jsonRequest("/api/v1/auth/login", { email: "grace@example.com", password: "wrong" }, { "x-forwarded-for": "203.0.113.10" }));
      expect(response.status).toBe(401);
      const json = await parseJson<{ ok: false; error: { message: string } }>(response);
      expect(json.error.message).toBe("Invalid email or password");
    }

    const limited = await app.request(jsonRequest("/api/v1/auth/login", { email: "grace@example.com", password: "wrong" }, { "x-forwarded-for": "203.0.113.10" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("allows localhost origins on any port without allowing lookalike hosts", async () => {
    const app = createHttpApp();

    const localPortResponse = await app.request(new Request("http://localhost/healthz", { headers: { origin: "http://localhost:9999" } }));
    expect(localPortResponse.headers.get("access-control-allow-origin")).toBe("http://localhost:9999");

    const lookalikeResponse = await app.request(new Request("http://localhost/healthz", { headers: { origin: "http://localhost.evil.com" } }));
    expect(lookalikeResponse.headers.get("access-control-allow-origin")).toBe("http://localhost");
  });

  it("reports process liveness and configured dependency readiness separately", async () => {
    const app = createHttpApp();

    expect((await app.request("http://localhost/healthz")).status).toBe(200);
    const ready = await app.request("http://localhost/readyz");
    expect(ready.status).toBe(200);
    await expect(parseJson<{ ok: true; data: { status: string } }>(ready)).resolves.toEqual({
      ok: true,
      data: { status: "ready" }
    });
  });

  it("supports workspace channel and DM CRUD flow", async () => {
    const app = createHttpApp();
    const ownerResponse = await app.request(jsonRequest("/api/v1/auth/register", { email: "owner@example.com", password: "Password12345!", displayName: "Owner" }));
    const memberResponse = await app.request(jsonRequest("/api/v1/auth/register", { email: "member@example.com", password: "Password12345!", displayName: "Member" }));
    const owner = await parseJson<{ ok: true; data: { user: { id: string }; tokens: { accessToken: string } } }>(ownerResponse);
    const member = await parseJson<{ ok: true; data: { user: { id: string } } }>(memberResponse);
    const auth = { authorization: `Bearer ${owner.data.tokens.accessToken}` };

    const workspaceResponse = await app.request(jsonRequest("/api/v1/workspaces", { name: "Workspace" }, auth));
    expect(workspaceResponse.status).toBe(201);
    const workspace = await parseJson<{ ok: true; data: { id: string; name: string } }>(workspaceResponse);

    const updateResponse = await app.request(new Request(`http://localhost/api/v1/workspaces/${workspace.data.id}`, { method: "PATCH", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ name: "Renamed" }) }));
    expect(updateResponse.status).toBe(200);

    const addMemberResponse = await app.request(jsonRequest(`/api/v1/workspaces/${workspace.data.id}/members`, { userId: member.data.user.id, role: "member" }, auth));
    expect(addMemberResponse.status).toBe(200);

    const channelsResponse = await app.request(new Request(`http://localhost/api/v1/workspaces/${workspace.data.id}/channels`, { headers: auth }));
    const channels = await parseJson<{ ok: true; data: Array<{ id: string; name: string }> }>(channelsResponse);
    expect(channels.data.some((channel) => channel.name === "general")).toBe(true);

    const channelResponse = await app.request(jsonRequest(`/api/v1/workspaces/${workspace.data.id}/channels`, { name: "private", mode: "normal", isPrivate: true }, auth));
    expect(channelResponse.status).toBe(201);
    const channel = await parseJson<{ ok: true; data: { id: string } }>(channelResponse);

    expect((await app.request(jsonRequest(`/api/v1/channels/${channel.data.id}/members`, { userId: member.data.user.id }, auth))).status).toBe(200);
    expect((await app.request(jsonRequest(`/api/v1/channels/${channel.data.id}/archive`, {}, auth))).status).toBe(200);
    expect((await app.request(new Request(`http://localhost/api/v1/channels/${channel.data.id}`, { method: "DELETE", headers: auth }))).status).toBe(200);

    const dmResponse = await app.request(jsonRequest(`/api/v1/dms?workspaceId=${workspace.data.id}`, { peerUserId: member.data.user.id, mode: "normal" }, auth));
    const sameDmResponse = await app.request(jsonRequest(`/api/v1/dms?workspaceId=${workspace.data.id}`, { peerUserId: member.data.user.id, mode: "normal" }, auth));
    const dm = await parseJson<{ ok: true; data: { id: string } }>(dmResponse);
    const sameDm = await parseJson<{ ok: true; data: { id: string } }>(sameDmResponse);
    expect(sameDm.data.id).toBe(dm.data.id);
    expect(owner.data.user.id).toBeTruthy();
  });
});
