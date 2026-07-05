import { hash, verify } from "@node-rs/argon2";
import { createId } from "@paralleldrive/cuid2";
import jwt from "jsonwebtoken";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { apiFail, authSessionSchema, nowIso, type AuthSession, type User } from "@nexus-chat/shared";
import { env } from "../../config/env.js";
import { store } from "../store.js";
import { refreshSessionStore } from "./session-store.js";

const localKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = env.JWT_PRIVATE_KEY_PEM || localKeyPair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const publicKey = env.JWT_PUBLIC_KEY_PEM || localKeyPair.publicKey.export({ type: "pkcs1", format: "pem" }).toString();

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const publicUser = (user: { id: string; email: string; displayName: string; createdAt: string }): User => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  createdAt: user.createdAt
});

export type AuthResult = { ok: true; session: AuthSession } | { ok: false; error: ReturnType<typeof apiFail> };

export const issueAccessToken = (userId: string) =>
  jwt.sign({ sub: userId }, privateKey, {
    algorithm: "RS256",
    expiresIn: "15m",
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    keyid: env.JWT_KID
  });

export const verifyAccessToken = (token: string): string | null => {
  try {
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ["RS256"],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE
    });
    return typeof decoded === "object" && typeof decoded.sub === "string" ? decoded.sub : null;
  } catch {
    return null;
  }
};

const createSession = async (user: User): Promise<AuthSession> => {
  const refreshToken = `nxrefresh_${randomBytes(32).toString("base64url")}`;
  await refreshSessionStore.set(refreshToken, {
    userId: user.id,
    tokenHash: tokenHash(refreshToken),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
  });
  return authSessionSchema.parse({
    user,
    tokens: { accessToken: issueAccessToken(user.id), refreshToken, expiresInSeconds: 900 }
  });
};

export const authService = {
  async register(email: string, password: string, displayName: string): Promise<AuthResult> {
    if (store.usersByEmail.has(email)) return { ok: false, error: apiFail("CONFLICT", "Email is already registered") };
    const id = createId();
    const passwordHash = await hash(password, { memoryCost: 65536, timeCost: 3, parallelism: 4 });
    const user = { id, email, displayName, passwordHash, createdAt: nowIso() };
    store.users.set(id, user);
    store.usersByEmail.set(email, id);
    store.auditLogs.push({ id: createId(), actorUserId: id, action: "auth.register", metadata: {}, createdAt: nowIso() });
    return { ok: true, session: await createSession(publicUser(user)) };
  },
  async login(email: string, password: string): Promise<AuthResult> {
    const userId = store.usersByEmail.get(email);
    const user = userId ? store.users.get(userId) : undefined;
    if (!user || !(await verify(user.passwordHash, password))) {
      return { ok: false, error: apiFail("AUTH_INVALID_CREDENTIALS", "Invalid email or password") };
    }
    store.auditLogs.push({ id: createId(), actorUserId: user.id, action: "auth.login", metadata: {}, createdAt: nowIso() });
    return { ok: true, session: await createSession(publicUser(user)) };
  },
  async refresh(refreshToken: string): Promise<AuthResult> {
    const session = await refreshSessionStore.get(refreshToken);
    if (!session || session.revokedAt || session.expiresAt < Date.now() || session.tokenHash !== tokenHash(refreshToken)) {
      if (session) await refreshSessionStore.revoke(refreshToken);
      store.auditLogs.push({ id: createId(), actorUserId: session?.userId, action: "auth.refresh_reuse_detected", metadata: {}, createdAt: nowIso() });
      return { ok: false, error: apiFail("AUTH_REFRESH_REPLAY", "Refresh token is invalid or was reused") };
    }
    await refreshSessionStore.revoke(refreshToken);
    const user = store.users.get(session.userId);
    if (!user) return { ok: false, error: apiFail("AUTH_REQUIRED", "Session user no longer exists") };
    return { ok: true, session: await createSession(publicUser(user)) };
  },
  async logout(refreshToken: string): Promise<void> {
    await refreshSessionStore.revoke(refreshToken);
  },
  me(userId: string): User | undefined {
    const user = store.users.get(userId);
    return user ? publicUser(user) : undefined;
  },
  lookupByEmail(email: string): User | undefined {
    const userId = store.usersByEmail.get(email);
    const user = userId ? store.users.get(userId) : undefined;
    return user ? publicUser(user) : undefined;
  }
};
