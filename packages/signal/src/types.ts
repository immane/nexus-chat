/**
 * IE2eeProvider Interface & E2EE Type Definitions
 *
 * Defines the 7-method abstraction (IE2eeProvider) that all E2EE backends
 * must implement, plus the data types for identities, sessions, ciphertexts,
 * and file encryption.
 *
 * Provider Implementations:
 * - noble.ts (default): ECDH P-256 + AES-256-GCM via @noble/curves + @noble/ciphers
 *   Pure JS, works over plain HTTP, MIT license.
 * - webcrypto.ts: SubtleCrypto-based ECDH + AES-256-GCM. Requires HTTPS/localhost.
 * - placeholder.ts (@deprecated): Base64 "encryption" for Phase 3 Signal Protocol stub.
 *
 * Design Decisions:
 * - IE2eeProvider is an interface (not a class) to allow swappable backends
 *   without a factory pattern — each provider file exports a singleton object.
 * - SignalSession contains a raw sharedKey (Uint8Array) rather than wrapping it
 *   in a class, keeping the serialization surface minimal.
 * - createInMemorySignalSessionStore is the reference in-memory store; production
 *   can implement SignalSessionStore with IndexedDB or a secure enclave.
 *
 * Related Modules:
 * - @nexus-chat/shared: SignalPreKeyBundle type used in toPreKeyBundle/establishSession
 */
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
