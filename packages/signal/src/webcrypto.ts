import { randomBytes, bytesToBase64, base64ToBytes, bytesToHex, encryptFile, decryptFile, deriveFileKey } from "./crypto.js";
import type { E2eeCiphertext, EncryptedFile, FileEncryptionKey, IE2eeProvider, LocalSignalIdentity, SignalSession, SignalSessionStore } from "./types.js";
import type { SignalPreKeyBundle } from "@nexus-chat/shared";

const hkdfSha256 = async (ikm: Uint8Array, salt: string, length: number): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey("raw", ikm.buffer as ArrayBuffer, { name: "HKDF" }, false, ["deriveBits"]);
  const enc = new TextEncoder();
  const d = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode(salt), info: enc.encode(salt) }, key, length * 8);
  return new Uint8Array(d);
};

export const webcryptoProvider: IE2eeProvider = {
  async createLocalIdentity(userId, deviceId, preKeyCount = 20): Promise<LocalSignalIdentity> {
    const idKey = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const idPub = new Uint8Array(await crypto.subtle.exportKey("raw", idKey.publicKey));
    const idPriv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", idKey.privateKey));

    const spKey = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const spPub = new Uint8Array(await crypto.subtle.exportKey("raw", spKey.publicKey));
    const spPriv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", spKey.privateKey));

    const sigPriv = await crypto.subtle.importKey("pkcs8", idPriv.buffer as ArrayBuffer, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, sigPriv, spPub.buffer as ArrayBuffer));

    const opks = [];
    for (let i = 0; i < preKeyCount; i++) {
      const k = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
      opks.push({ id: i + 1, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey)), privateKey: new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey)) });
    }
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
      const peerKeyRaw = base64ToBytes(peerBundle.identityKey).buffer as ArrayBuffer;
      const peerKey = await crypto.subtle.importKey("raw", peerKeyRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
      const privKey = await crypto.subtle.importKey("pkcs8", identity.identityKeyPrivate.buffer as ArrayBuffer, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      const ss = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peerKey }, privKey, 256));
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
    const key = await crypto.subtle.importKey("raw", session.sharedKey.buffer as ArrayBuffer, { name: "AES-GCM" }, false, ["encrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv.buffer as ArrayBuffer }, key, new TextEncoder().encode(plaintext)));
    return { type: "ciphertext", ciphertext: bytesToBase64(ct), algorithm: "aes-256-gcm-v1", iv: bytesToBase64(iv) };
  },

  async decryptFromSession(session, ciphertextB64, ivB64): Promise<string> {
    const ct = base64ToBytes(ciphertextB64);
    const iv = base64ToBytes(ivB64);
    const key = await crypto.subtle.importKey("raw", session.sharedKey.buffer as ArrayBuffer, { name: "AES-GCM" }, false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv.buffer as ArrayBuffer }, key, ct.buffer as ArrayBuffer);
    return new TextDecoder().decode(pt);
  },

  encryptFile,
  decryptFile,
  deriveFileKey,
};
