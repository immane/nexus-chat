import type { SignalPreKeyBundle } from "@nexus-chat/shared";

export type LocalSignalIdentity = {
  userId: string;
  deviceId: string;
  identityKeyPublic: string;
  identityKeyPrivate: string;
  signedPreKeyPublic: string;
  signedPreKeyPrivate: string;
  signedPreKeySignature: string;
  oneTimePreKeys: Array<{ id: number; publicKey: string; privateKey: string }>;
};

export type SignalSession = { sessionId: string; peerUserId: string; peerDeviceId: string; establishedAt: string };

export type SignalSessionStore = {
  get(sessionId: string): SignalSession | undefined;
  set(sessionId: string, session: SignalSession): void;
  listByPeer(userId: string, deviceId: string): SignalSession[];
  delete(sessionId: string): void;
};

export const createInMemorySignalSessionStore = (): SignalSessionStore => {
  const sessions = new Map<string, SignalSession>();
  return {
    get(sessionId) { return sessions.get(sessionId); },
    set(sessionId, session) { sessions.set(sessionId, session); },
    listByPeer(userId, deviceId) {
      return [...sessions.values()].filter((s) => s.peerUserId === userId && s.peerDeviceId === deviceId);
    },
    delete(sessionId) { sessions.delete(sessionId); }
  };
};

const randomString = () => crypto.getRandomValues(new Uint8Array(32)).reduce((value, byte) => value + byte.toString(16).padStart(2, "0"), "");

export const createLocalSignalIdentity = (userId: string, deviceId: string, oneTimePreKeyCount = 20): LocalSignalIdentity => ({
  userId,
  deviceId,
  identityKeyPublic: randomString(),
  identityKeyPrivate: randomString(),
  signedPreKeyPublic: randomString(),
  signedPreKeyPrivate: randomString(),
  signedPreKeySignature: randomString(),
  oneTimePreKeys: Array.from({ length: oneTimePreKeyCount }, (_, index) => ({ id: index + 1, publicKey: randomString(), privateKey: randomString() }))
});

export const toPreKeyBundle = (identity: LocalSignalIdentity): SignalPreKeyBundle => ({
  userId: identity.userId,
  deviceId: identity.deviceId,
  identityKey: identity.identityKeyPublic,
  signedPreKeyId: 1,
  signedPreKey: identity.signedPreKeyPublic,
  signedPreKeySignature: identity.signedPreKeySignature,
  oneTimePreKeyId: identity.oneTimePreKeys[0]?.id,
  oneTimePreKey: identity.oneTimePreKeys[0]?.publicKey
});

export const extractOneTimePreKeys = (identity: LocalSignalIdentity): Array<{ keyId: number; publicKey: string }> =>
  identity.oneTimePreKeys.map((pk) => ({ keyId: pk.id, publicKey: pk.publicKey }));

export const consumeOneTimePreKey = (identity: LocalSignalIdentity, keyId: number): boolean => {
  const index = identity.oneTimePreKeys.findIndex((pk) => pk.id === keyId);
  if (index === -1) return false;
  identity.oneTimePreKeys.splice(index, 1);
  return true;
};

export const establishSession = (_identity: LocalSignalIdentity, peerBundle: SignalPreKeyBundle, sessionStore?: SignalSessionStore): SignalSession => {
  const session: SignalSession = {
    sessionId: `signal:${peerBundle.userId}:${peerBundle.deviceId}:${randomString()}`,
    peerUserId: peerBundle.userId,
    peerDeviceId: peerBundle.deviceId,
    establishedAt: new Date().toISOString()
  };
  if (sessionStore) sessionStore.set(session.sessionId, session);
  return session;
};

export const encryptForSession = async (_session: SignalSession, plaintext: string) => ({
  type: "ciphertext" as const,
  ciphertext: btoa(plaintext),
  algorithm: "signal-v1" as const
});

export const decryptFromSession = async (_session: SignalSession, ciphertext: string) => atob(ciphertext);
