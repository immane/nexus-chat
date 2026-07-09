import { placeholderProvider } from "./placeholder.js";
import { nobleProvider } from "./noble.js";
import { webcryptoProvider } from "./webcrypto.js";
import type { E2eeCiphertext, EncryptedFile, FileEncryptionKey, IE2eeProvider, LocalSignalIdentity, SignalSession, SignalSessionStore } from "./types.js";
import { createInMemorySignalSessionStore } from "./types.js";
import type { SignalPreKeyBundle } from "@nexus-chat/shared";

export type { LocalSignalIdentity, SignalSession, SignalSessionStore, E2eeCiphertext, EncryptedFile, FileEncryptionKey, IE2eeProvider };
export { createInMemorySignalSessionStore };

function selectProvider(): IE2eeProvider {
  /* c8 ignore next */
  const backend = typeof process !== "undefined" ? process.env.E2EE_BACKEND : undefined;

  if (backend === "noble") return nobleProvider;

  if (backend === "webcrypto") {
    if (typeof window !== "undefined" && window.isSecureContext) return webcryptoProvider;
    console.warn("[E2EE] Web Crypto requires secure context (HTTPS/localhost). Falling back.");
  }

  if (backend === "placeholder") return placeholderProvider;

  return nobleProvider;
}

const provider: IE2eeProvider = selectProvider();

export const createLocalSignalIdentity = (userId: string, deviceId: string, preKeyCount?: number): Promise<LocalSignalIdentity> =>
  provider.createLocalIdentity(userId, deviceId, preKeyCount);

export const toPreKeyBundle = (identity: LocalSignalIdentity): SignalPreKeyBundle =>
  provider.toPreKeyBundle(identity);

export const establishSession = (identity: LocalSignalIdentity, peerBundle: SignalPreKeyBundle, sessionStore?: SignalSessionStore): Promise<SignalSession> =>
  provider.establishSession(identity, peerBundle, sessionStore);

export const encryptForSession = async (session: SignalSession, plaintext: string): Promise<E2eeCiphertext> => {
  const result = await provider.encryptForSession(session, plaintext);
  return { type: "ciphertext", ciphertext: `${result.iv}.${result.ciphertext}`, algorithm: result.algorithm, iv: result.iv };
};

export const decryptFromSession = async (session: SignalSession, ciphertext: string): Promise<string> => {
  const dot = ciphertext.indexOf(".");
  if (dot > 0) {
    const iv = ciphertext.slice(0, dot);
    const ct = ciphertext.slice(dot + 1);
    return provider.decryptFromSession(session, ct, iv);
  }
  return provider.decryptFromSession(session, ciphertext, "");
};

export const encryptFile = (file: Blob, key: FileEncryptionKey): Promise<EncryptedFile> =>
  provider.encryptFile(file, key);

export const decryptFile = (encrypted: EncryptedFile, key: FileEncryptionKey): Promise<Blob> =>
  provider.decryptFile(encrypted, key);

export const deriveFileKey = (session: SignalSession): Promise<FileEncryptionKey> =>
  provider.deriveFileKey(session);

export const extractOneTimePreKeys = (identity: LocalSignalIdentity): Array<{ keyId: number; publicKey: string }> => {
  const hex = identity.oneTimePreKeys.map((pk) => ({ keyId: pk.id, publicKey: Array.from(pk.publicKey, (b) => b.toString(16).padStart(2, "0")).join("") }));
  return hex;
};

export const consumeOneTimePreKey = (identity: LocalSignalIdentity, keyId: number): boolean => {
  const index = identity.oneTimePreKeys.findIndex((pk) => pk.id === keyId);
  if (index === -1) return false;
  identity.oneTimePreKeys.splice(index, 1);
  return true;
};
