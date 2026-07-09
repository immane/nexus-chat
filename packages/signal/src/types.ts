import type { SignalPreKeyBundle } from "@nexus-chat/shared";

export type LocalSignalIdentity = {
  userId: string;
  deviceId: string;
  identityKeyPublic: Uint8Array;
  identityKeyPrivate: Uint8Array;
  signedPreKeyPublic: Uint8Array;
  signedPreKeyPrivate: Uint8Array;
  signedPreKeySignature: Uint8Array;
  oneTimePreKeys: Array<{ id: number; publicKey: Uint8Array; privateKey: Uint8Array }>;
};

export type SignalSession = {
  sessionId: string;
  peerUserId: string;
  peerDeviceId: string;
  establishedAt: string;
  sharedKey: Uint8Array;
};

export type SignalSessionStore = {
  get(sessionId: string): SignalSession | undefined;
  set(sessionId: string, session: SignalSession): void;
  listByPeer(userId: string, deviceId: string): SignalSession[];
  delete(sessionId: string): void;
};

export type E2eeCiphertext = {
  type: "ciphertext";
  ciphertext: string;
  algorithm: "aes-256-gcm-v1" | "signal-v1";
  iv: string;
};

export type EncryptedFile = {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
};

export type FileEncryptionKey = Uint8Array;

export interface IE2eeProvider {
  createLocalIdentity(
    userId: string,
    deviceId: string,
    preKeyCount?: number
  ): Promise<LocalSignalIdentity>;

  toPreKeyBundle(identity: LocalSignalIdentity): SignalPreKeyBundle;

  establishSession(
    identity: LocalSignalIdentity,
    peerBundle: SignalPreKeyBundle,
    sessionStore?: SignalSessionStore
  ): Promise<SignalSession>;

  encryptForSession(
    session: SignalSession,
    plaintext: string
  ): Promise<E2eeCiphertext>;

  decryptFromSession(
    session: SignalSession,
    ciphertext: string,
    iv: string
  ): Promise<string>;

  encryptFile(
    file: Blob,
    key: FileEncryptionKey
  ): Promise<EncryptedFile>;

  decryptFile(
    encrypted: EncryptedFile,
    key: FileEncryptionKey
  ): Promise<Blob>;

  deriveFileKey(session: SignalSession): Promise<FileEncryptionKey>;
}

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
