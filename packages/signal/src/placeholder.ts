/**
 * ═══════════════════════════════════════════════════════════════
 *  E2EE PLACEHOLDER — PHASE 3 SIGNAL PROTOCOL STUB
 * ═══════════════════════════════════════════════════════════════
 *
 * THIS FILE PROVIDES ZERO SECURITY. ALL "ENCRYPTION" IS FAKE.
 *
 * What it does (safe for development / CI testing only):
 *   - Generates random hex strings as mock ECDH keypairs
 *   - Uses Base64 encoding (btoa/atob) as mock encryption
 *   - Creates session IDs without real Diffie-Hellman exchange
 *
 * What it DOES NOT do — deferred to Phase 3 (AGPL-3.0 branch):
 *   - X3DH key agreement (3-way DH: identity + signed prekey + OPK)
 *   - Double Ratchet (per-message key rotation with forward secrecy)
 *   - Authenticated encryption (AES-256-GCM with IV and auth tag)
 *   - Any real cryptographic operation whatsoever
 *
 * Branches and license:
 *   - main branch (MIT): uses @noble/* (noble.ts) for ECDH + AES-256-GCM
 *   - Phase 3 branch (AGPL-3.0): uses @signalapp/libsignal (libsignal.ts)
 *     for X3DH + Double Ratchet on a SEPARATE distribution branch
 *     NOT merged into main, to avoid AGPL-3.0 copyleft contamination
 *
 * Production implementations (see IE2eeProvider interface):
 *   - noble.ts: @noble/curves + @noble/ciphers (ECDH P-256 + AES-256-GCM)
 *   - webcrypto.ts: SubtleCrypto (ECDH P-256 + AES-256-GCM, HTTPS only)
 *
 * NEVER deploy this placeholder to production.
 * Set E2EE_BACKEND=noble for real encryption in CI/testing.
 *
 * @see docs/design/10_E2EE_Encryption_Abstract_Layer.md
 * @see docs/tasks/27-phase-1-e2ee-real-encryption.md
 * @deprecated — This entire file is a Phase 3 Signal Protocol stub. Real encryption: see Task #27.
 */
import type { SignalPreKeyBundle } from "@nexus-chat/shared";
import type { E2eeCiphertext, EncryptedFile, FileEncryptionKey, IE2eeProvider, LocalSignalIdentity, SignalSession, SignalSessionStore } from "./types.js";
import { createInMemorySignalSessionStore } from "./types.js";

const randomString = () => crypto.getRandomValues(new Uint8Array(32)).reduce((v, b) => v + b.toString(16).padStart(2, "0"), "");

export { createInMemorySignalSessionStore };
export type { LocalSignalIdentity, SignalSession, SignalSessionStore, E2eeCiphertext, EncryptedFile, FileEncryptionKey, IE2eeProvider };

/** @deprecated Phase 3 placeholder. Real impl: see Task #27. */
export const placeholderProvider: IE2eeProvider = {
  /** @deprecated Placeholder — random hex, not ECDH. Real impl: noble.ts (Task #27). */
  async createLocalIdentity(userId: string, deviceId: string, preKeyCount = 20): Promise<LocalSignalIdentity> {
    return {
      userId, deviceId,
      identityKeyPublic: new TextEncoder().encode(randomString()),
      identityKeyPrivate: new TextEncoder().encode(randomString()),
      signedPreKeyPublic: new TextEncoder().encode(randomString()),
      signedPreKeyPrivate: new TextEncoder().encode(randomString()),
      signedPreKeySignature: new TextEncoder().encode(randomString()),
      oneTimePreKeys: Array.from({ length: preKeyCount }, (_v, i) => ({
        id: i + 1, publicKey: new TextEncoder().encode(randomString()), privateKey: new TextEncoder().encode(randomString())
      }))
    };
  },

  toPreKeyBundle(identity: LocalSignalIdentity): SignalPreKeyBundle {
    const td = new TextDecoder();
    return {
      userId: identity.userId, deviceId: identity.deviceId,
      identityKey: td.decode(identity.identityKeyPublic),
      signedPreKeyId: 1, signedPreKey: td.decode(identity.signedPreKeyPublic),
      signedPreKeySignature: td.decode(identity.signedPreKeySignature),
      oneTimePreKeyId: identity.oneTimePreKeys[0]?.id,
      oneTimePreKey: identity.oneTimePreKeys[0] ? td.decode(identity.oneTimePreKeys[0].publicKey) : undefined
    };
  },

  /** @deprecated Placeholder — no DH exchange. Phase 3 stub. Real impl: noble.ts (Task #27). */
  async establishSession(_identity, peerBundle, sessionStore): Promise<SignalSession> {
    const session: SignalSession = {
      sessionId: `signal:${peerBundle.userId}:${peerBundle.deviceId}:${randomString()}`,
      peerUserId: peerBundle.userId, peerDeviceId: peerBundle.deviceId,
      establishedAt: new Date().toISOString(), sharedKey: new Uint8Array(32)
    };
    sessionStore?.set(session.sessionId, session);
    return session;
  },

  /** @deprecated Placeholder — btoa(), NOT AES-256-GCM. Phase 3 stub. Real impl: noble.ts (Task #27). */
  async encryptForSession(_session, plaintext): Promise<E2eeCiphertext> {
    return { type: "ciphertext", ciphertext: btoa(plaintext), algorithm: "signal-v1", iv: btoa("\0\0\0\0\0\0\0\0\0\0\0\0") };
  },

  /** @deprecated Placeholder — atob(), NOT AES-256-GCM. Phase 3 stub. Real impl: noble.ts (Task #27). */
  async decryptFromSession(_session, ciphertext): Promise<string> {
    return atob(ciphertext);
  },

  async encryptFile(blob: Blob): Promise<EncryptedFile> {
    const b = new Uint8Array(await blob.arrayBuffer());
    return { ciphertext: b, iv: new Uint8Array(12), originalName: (blob as File).name ?? "unknown", mimeType: blob.type, sizeBytes: b.length };
  },

  async decryptFile(encrypted: EncryptedFile): Promise<Blob> {
    return new Blob([encrypted.ciphertext as unknown as BlobPart]);
  },

  async deriveFileKey(session: SignalSession): Promise<FileEncryptionKey> {
    return session.sharedKey;
  },
};
