/**
 * Signal / E2EE Service
 *
 * Owns pre-key bundle upload, one-time pre-key consumption, and session management.
 *
 * Responsibilities:
 * - Accept and store signed pre-key bundles with optional one-time pre-keys
 * - Serve pre-key bundles for recipient lookup (X3DH initiation)
 * - Consume one-time pre-keys with atomic operational control
 * - Track remaining one-time pre-key count per device
 * - Persist Signal sessions for ratchet continuity
 *
 * Does NOT:
 * - Perform X3DH key agreement or Double Ratchet (client-side only)
 * - Handle ciphertext content processing
 * - Manage WebRTC or P2P session metadata
 *
 * Invariants:
 * - Bundle upload requires the actor to match the bundle userId (ownership check)
 * - Session ids are UUIDs, not derived from participant identifiers
 * - One-time pre-key consumption is idempotent via persistence control
 *
 * Dependencies:
 * - SignalPersistence (in-memory or PostgreSQL)
 * - createId for session identifier generation
 *
 * Related Modules:
 * - persistence.ts: SignalPersistence interface and adapters
 */
import { createId } from "@paralleldrive/cuid2";
import { apiFail, nowIso, type SignalPreKeyBundle } from "@nexus-chat/shared";
import { getSignalPersistence } from "./persistence.js";

export const signalService = {
  async uploadBundle(
    actor: string,
    bundle: SignalPreKeyBundle,
    keys?: Array<{ keyId: number; publicKey: string }>
  ) {
    if (actor !== bundle.userId)
      return apiFail(
        "FORBIDDEN",
        "Cannot upload Signal keys for another user"
      );
    await (await getSignalPersistence()).upload(bundle, keys);
    return bundle;
  },

  async fetchBundle(_actor: string, userId: string, deviceId: string) {
    return (
      (await (await getSignalPersistence()).takeBundle(userId, deviceId)) ??
      apiFail("NOT_FOUND", "Signal pre-key bundle not found")
    );
  },

  async consumeOneTimePreKey(
    userId: string,
    deviceId: string,
    keyId: number
  ) {
    const result = await (
      await getSignalPersistence()
    ).consume(userId, deviceId, keyId);
    if (result === "consumed") return { consumed: true as const };
    return apiFail(
      result === "missing" ? "NOT_FOUND" : "CONFLICT",
      result === "missing"
        ? "One-time pre-key not found"
        : "One-time pre-key already consumed"
    );
  },

  async getRemainingPreKeyCount(userId: string, deviceId: string) {
    return (await getSignalPersistence()).count(userId, deviceId);
  },

  async storeSession(
    owner: string,
    peer: string,
    device: string,
    metadata: unknown = {}
  ) {
    const id = createId();
    await (await getSignalPersistence()).createSession({
      id,
      ownerUserId: owner,
      peerUserId: peer,
      deviceId: device,
      metadata,
      updatedAt: nowIso()
    });
    return { id };
  },

  async getSession(id: string) {
    return (
      (await (await getSignalPersistence()).session(id)) ??
      apiFail("NOT_FOUND", "Signal session not found")
    );
  },

  async listUserSessions(user: string) {
    return (await getSignalPersistence()).sessions(user);
  }
};
