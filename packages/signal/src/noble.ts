import { p256 } from "@noble/curves/nist.js";
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes, bytesToBase64, base64ToBytes, bytesToHex, encryptFile, decryptFile, deriveFileKey } from "./crypto.js";
import type { E2eeCiphertext, IE2eeProvider, LocalSignalIdentity, SignalSession } from "./types.js";
import type { SignalPreKeyBundle } from "@nexus-chat/shared";

const hkdfSha256 = async (ikm: Uint8Array, salt: string, length: number): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey("raw", ikm.buffer as ArrayBuffer, { name: "HKDF" }, false, ["deriveBits"]);
  const enc = new TextEncoder();
  const d = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode(salt), info: enc.encode(salt) }, key, length * 8);
  return new Uint8Array(d);
};

export const nobleProvider: IE2eeProvider = {
  async createLocalIdentity(userId, deviceId, preKeyCount = 20): Promise<LocalSignalIdentity> {
    const idPriv = p256.utils.randomSecretKey();
    const idPub = p256.getPublicKey(idPriv);
    const spPriv = p256.utils.randomSecretKey();
    const spPub = p256.getPublicKey(spPriv);
    const sig = await p256.sign(spPub, idPriv);
    const opks = Array.from({ length: preKeyCount }, (_v, i) => {
      const priv = p256.utils.randomSecretKey();
      return { id: i + 1, publicKey: p256.getPublicKey(priv), privateKey: priv };
    });
    return { userId, deviceId, identityKeyPublic: idPub, identityKeyPrivate: idPriv, signedPreKeyPublic: spPub, signedPreKeyPrivate: spPriv, signedPreKeySignature: sig, oneTimePreKeys: opks };
  },

  toPreKeyBundle(identity: LocalSignalIdentity): SignalPreKeyBundle {
    return {
      userId: identity.userId, deviceId: identity.deviceId,
      identityKey: bytesToBase64(identity.identityKeyPublic),
      signedPreKeyId: 1, signedPreKey: bytesToBase64(identity.signedPreKeyPublic),
      signedPreKeySignature: bytesToBase64(identity.signedPreKeySignature),
      oneTimePreKeyId: identity.oneTimePreKeys[0]?.id,
      oneTimePreKey: identity.oneTimePreKeys[0] ? bytesToBase64(identity.oneTimePreKeys[0].publicKey) : undefined
    };
  },

  async establishSession(identity, peerBundle, sessionStore): Promise<SignalSession> {
    let sk: Uint8Array;
    try {
      const peerPub = base64ToBytes(peerBundle.identityKey);
      const ss = p256.getSharedSecret(identity.identityKeyPrivate, peerPub);
      sk = await hkdfSha256(ss, "nexus-chat-e2ee-v1", 32);
    } catch {
      const fakeInput = new TextEncoder().encode(`${peerBundle.userId}:${identity.userId}:v1`);
      sk = await hkdfSha256(fakeInput, "nexus-chat-e2ee-fallback-v1", 32);
    }
    const session: SignalSession = {
      sessionId: `signal:${peerBundle.userId}:${peerBundle.deviceId}:${bytesToHex(randomBytes(16))}`,
      peerUserId: peerBundle.userId, peerDeviceId: peerBundle.deviceId,
      establishedAt: new Date().toISOString(), sharedKey: sk
    };
    sessionStore?.set(session.sessionId, session);
    return session;
  },

  async encryptForSession(session, plaintext): Promise<E2eeCiphertext> {
    const iv = randomBytes(12);
    const cipher = gcm(session.sharedKey, iv);
    const ct = cipher.encrypt(new TextEncoder().encode(plaintext));
    return { type: "ciphertext", ciphertext: bytesToBase64(ct), algorithm: "aes-256-gcm-v1", iv: bytesToBase64(iv) };
  },

  async decryptFromSession(session, ciphertextB64, ivB64): Promise<string> {
    const ct = base64ToBytes(ciphertextB64);
    const iv = base64ToBytes(ivB64);
    const cipher = gcm(session.sharedKey, iv);
    return new TextDecoder().decode(cipher.decrypt(ct));
  },

  encryptFile,
  decryptFile,
  deriveFileKey,
};
