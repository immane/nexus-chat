import { createId } from "@paralleldrive/cuid2";
import { apiFail, nowIso, type SignalPreKeyBundle } from "@nexus-chat/shared";
import { store } from "../store.js";

const bundleKey = (userId: string, deviceId: string) => `${userId}:${deviceId}`;
const preKeyKey = (userId: string, deviceId: string, keyId: number) => `${userId}:${deviceId}:${keyId}`;

export const signalService = {
  uploadBundle(actorId: string, bundle: SignalPreKeyBundle, oneTimePreKeys?: Array<{ keyId: number; publicKey: string }>): SignalPreKeyBundle | ReturnType<typeof apiFail> {
    if (actorId !== bundle.userId) return apiFail("FORBIDDEN", "Cannot upload Signal keys for another user");
    store.signalBundles.set(bundleKey(bundle.userId, bundle.deviceId), bundle);
    if (oneTimePreKeys) {
      for (const pk of oneTimePreKeys) {
        store.oneTimePreKeys.set(preKeyKey(bundle.userId, bundle.deviceId, pk.keyId), { userId: bundle.userId, deviceId: bundle.deviceId, keyId: pk.keyId, publicKey: pk.publicKey });
      }
    }
    return bundle;
  },

  fetchBundle(_actorId: string, userId: string, deviceId: string): SignalPreKeyBundle | (SignalPreKeyBundle & { oneTimePreKeyId: number; oneTimePreKey: string }) | ReturnType<typeof apiFail> {
    const bundle = store.signalBundles.get(bundleKey(userId, deviceId));
    if (!bundle) return apiFail("NOT_FOUND", "Signal pre-key bundle not found");

    const availablePreKey = [...store.oneTimePreKeys.values()]
      .find((pk) => pk.userId === userId && pk.deviceId === deviceId && !pk.consumedAt);

    if (availablePreKey) {
      availablePreKey.consumedAt = nowIso();
      return { ...bundle, oneTimePreKeyId: availablePreKey.keyId, oneTimePreKey: availablePreKey.publicKey } as SignalPreKeyBundle & { oneTimePreKeyId: number; oneTimePreKey: string };
    }

    return { ...bundle } as SignalPreKeyBundle;
  },

  consumeOneTimePreKey(userId: string, deviceId: string, keyId: number): { consumed: true } | ReturnType<typeof apiFail> {
    const key = preKeyKey(userId, deviceId, keyId);
    const preKey = store.oneTimePreKeys.get(key);
    if (!preKey) return apiFail("NOT_FOUND", "One-time pre-key not found");
    if (preKey.consumedAt) return apiFail("CONFLICT", "One-time pre-key already consumed");
    preKey.consumedAt = nowIso();
    return { consumed: true };
  },

  getRemainingPreKeyCount(userId: string, deviceId: string): number {
    return [...store.oneTimePreKeys.values()].filter((pk) => pk.userId === userId && pk.deviceId === deviceId && !pk.consumedAt).length;
  },

  storeSession(ownerUserId: string, peerUserId: string, deviceId: string, metadata: unknown = {}): { id: string } {
    const id = createId();
    store.signalSessions.set(id, { id, ownerUserId, peerUserId, deviceId, metadata, updatedAt: nowIso() });
    return { id };
  },

  getSession(sessionId: string) {
    return store.signalSessions.get(sessionId) ?? apiFail("NOT_FOUND", "Signal session not found");
  },

  listUserSessions(userId: string) {
    return [...store.signalSessions.values()].filter((session) => session.ownerUserId === userId || session.peerUserId === userId);
  }
};
