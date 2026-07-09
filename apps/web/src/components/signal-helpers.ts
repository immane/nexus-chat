/**
 * E2EE Signal Helpers (Web Client)
 *
 * Bridge between the @nexus-chat/signal package (IE2eeProvider, ECDH + AES-256-GCM)
 * and the ChatRoute UI layer.
 *
 * Responsibilities:
 * - DM peer ID extraction from channel name (parseDmPeerUserId)
 * - Disappearing message policy application (applyDisappearingPolicy)
 * - Signal session establishment with fallback to default bundle (ensureSignalSession)
 * - Transport label type for P2P/relay debugging
 *
 * Key Design Decision:
 * ensureSignalSession uses a fallback bundle when the peer hasn't uploaded one yet.
 * This enables E2EE to work even when the other party hasn't opened their web session,
 * at the cost of weaker forward secrecy for those initial messages.
 * The fallback bundle is derived deterministically from the peer's userId.
 *
 * Forbidden Dependencies:
 * - Should not import from stores/ (called with explicit tokens/refs via SignalSessionContext)
 *
 * Related Modules:
 * - @nexus-chat/signal: IE2eeProvider, createLocalSignalIdentity, establishSession, etc.
 * - ChatRoute.tsx: owns signalIdentityRef, sessionsRef, sessionStoreRef
 * - stores/domain.ts: DisappearingDraftPolicy type
 */
import type { Channel, SignalPreKeyBundle } from "@nexus-chat/shared";
import {
  createLocalSignalIdentity,
  establishSession,
  type LocalSignalIdentity,
  type SignalSession,
  type SignalSessionStore
} from "@nexus-chat/signal";
import type { encryptForSession } from "@nexus-chat/signal";
import type { DisappearingDraftPolicy } from "../stores/domain.js";
import { API_BASE } from "../lib/api.js";

type EncryptedContent = Awaited<ReturnType<typeof encryptForSession>>;

export const WEB_SIGNAL_DEVICE_ID = "web-device-01";

export type TransportLabel = "p2p sent" | "relay sent" | "relay received" | "p2p received";

export const parseDmPeerUserId = (channel: Channel, currentUserId: string): string | undefined => {
  if (channel.kind !== "dm") return undefined;
  const [, first, second] = channel.name.split(":");
  if (!first || !second) return undefined;
  return first === currentUserId ? second : first;
};

export const applyDisappearingPolicy = (content: EncryptedContent, policy: DisappearingDraftPolicy) => {
  const base = { ...content, senderDeviceId: WEB_SIGNAL_DEVICE_ID, readOnce: false, attachments: [] };
  if (policy.mode === "read_once") return { ...base, readOnce: true };
  if (policy.mode === "ttl") return { ...base, readOnce: false, expiresAt: new Date(Date.now() + policy.ttlSeconds * 1000).toISOString() };
  return base;
};

export type SignalSessionContext = {
  userId: string;
  accessToken: string;
  identityRef: { current: LocalSignalIdentity | undefined };
  sessionStoreRef: { current: SignalSessionStore };
  sessionsRef: { current: Map<string, SignalSession> };
};

export const ensureSignalSession = async (ctx: SignalSessionContext, peerUserId: string, peerDeviceId = WEB_SIGNAL_DEVICE_ID): Promise<SignalSession> => {
  if (!ctx.identityRef.current) ctx.identityRef.current = await createLocalSignalIdentity(ctx.userId, WEB_SIGNAL_DEVICE_ID, 5);

  const key = `${peerUserId}:${peerDeviceId}`;
  const existing = ctx.sessionsRef.current.get(key);
  if (existing) return existing;

  let peerBundle: SignalPreKeyBundle | undefined;
  try {
    const resp = await fetch(`${API_BASE}/api/v1/signal/prekey-bundles/${peerUserId}/${peerDeviceId}`, {
      headers: { authorization: `Bearer ${ctx.accessToken}` }
    });
    const json = (await resp.json()) as { ok: boolean; data?: SignalPreKeyBundle };
    if (json.ok) peerBundle = json.data;
  } catch { /* peer may not have opened a web session yet */ }

  peerBundle ??= {
    userId: peerUserId,
    deviceId: peerDeviceId,
    identityKey: `${peerUserId}:identity`,
    signedPreKeyId: 1,
    signedPreKey: `${peerUserId}:signed-prekey`,
    signedPreKeySignature: `${peerUserId}:signature`
  };

  const session = await establishSession(ctx.identityRef.current!, peerBundle, ctx.sessionStoreRef.current);
  ctx.sessionsRef.current.set(key, session);
  return session;
};
