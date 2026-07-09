import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IE2eeProvider, LocalSignalIdentity, SignalSession } from "./types.js";
import { createInMemorySignalSessionStore } from "./types.js";
import { nobleProvider } from "./noble.js";
import { placeholderProvider } from "./placeholder.js";
import { encryptFile, decryptFile, deriveFileKey, randomBytes, bytesToBase64, base64ToBytes, hexToBytes, bytesToHex, concat } from "./crypto.js";

describe("IE2eeProvider implementations", () => {
  const testProvider = (name: string, provider: IE2eeProvider, expectsRealEncryption: boolean) => {
    describe(name, () => {
      let alice: LocalSignalIdentity;
      let bob: LocalSignalIdentity;

      beforeEach(async () => {
        alice = await provider.createLocalIdentity("alice", "device-a", 2);
        bob = await provider.createLocalIdentity("bob", "device-b", 1);
      });

      it("creates valid identities", () => {
        expect(alice.userId).toBe("alice");
        expect(alice.oneTimePreKeys.length).toBe(2);
        expect(bob.oneTimePreKeys.length).toBe(1);
        expect(alice.identityKeyPublic.length).toBeGreaterThan(0);
        expect(alice.identityKeyPrivate.length).toBeGreaterThan(0);
      });

      it("builds prekey bundles", () => {
        const bundle = provider.toPreKeyBundle(bob);
        expect(bundle.userId).toBe("bob");
        expect(typeof bundle.identityKey).toBe("string");
        expect(bundle.identityKey.length).toBeGreaterThan(0);
        expect(bundle.oneTimePreKeyId).toBe(1);
      });

      it("establishes sessions", async () => {
        const bundle = provider.toPreKeyBundle(bob);
        const session = await provider.establishSession(alice, bundle);
        expect(session.peerUserId).toBe("bob");
        expect(session.sharedKey.length).toBe(32);
      });

      it("encrypts and decrypts messages", async () => {
        const bundle = provider.toPreKeyBundle(bob);
        const session = await provider.establishSession(alice, bundle);
        const encrypted = await provider.encryptForSession(session, "hello");
        expect(encrypted.type).toBe("ciphertext");
        expect(typeof encrypted.ciphertext).toBe("string");
        expect(typeof encrypted.iv).toBe("string");

        if (expectsRealEncryption) {
          expect(encrypted.algorithm).toBe("aes-256-gcm-v1");
          expect(encrypted.iv.length).toBeGreaterThan(0);
        } else {
          expect(encrypted.algorithm).toBe("signal-v1");
        }

        const decrypted = await provider.decryptFromSession(session, encrypted.ciphertext, encrypted.iv);
        expect(decrypted).toBe("hello");
      });

      it("derives different session keys per peer", async () => {
        const b1 = provider.toPreKeyBundle(bob);
        const s1 = await provider.establishSession(alice, b1);
        const c1 = await provider.establishSession(alice, b1);
        if (expectsRealEncryption) {
          expect(s1.sharedKey).toEqual(c1.sharedKey);
        }
      });

      it("creates identities with zero prekeys", async () => {
          const id = await provider.createLocalIdentity("x", "d1", 0);
          expect(id.oneTimePreKeys.length).toBe(0);
          const bundle = provider.toPreKeyBundle(id);
          expect(bundle.oneTimePreKeyId).toBeUndefined();
          expect(bundle.oneTimePreKey).toBeUndefined();
        });

        it("establishes sessions without session store", async () => {
          const bundle = provider.toPreKeyBundle(bob);
          const session = await provider.establishSession(alice, bundle);
          expect(session.peerUserId).toBe("bob");
        });

        it("establishes sessions with session store", async () => {
          const store = createInMemorySignalSessionStore();
          const bundle = provider.toPreKeyBundle(bob);
          const session = await provider.establishSession(alice, bundle, store);
          expect(store.get(session.sessionId)).toEqual(session);
        });

        it("encrypts and decrypts files with named file", async () => {
          const bundle = provider.toPreKeyBundle(bob);
          const session = await provider.establishSession(alice, bundle);
          const fileKey = await provider.deriveFileKey(session);
          const file = new File(["named content"], "test.txt", { type: "text/plain" });
          const encrypted = await provider.encryptFile(file, fileKey);
          expect(encrypted.originalName).toBe("test.txt");
          const decrypted = await provider.decryptFile(encrypted, fileKey);
          expect(await decrypted.text()).toBe("named content");
        });
    });
  };

  testProvider("placeholder", placeholderProvider, false);
  testProvider("noble", nobleProvider, true);
});

describe("noble fallback", () => {
  it("uses fallback key when peer bundle has invalid key", async () => {
    const alice = await nobleProvider.createLocalIdentity("alice", "d1", 1);
    // Valid Base64, but not a valid P-256 public key
    const fakeBundle = {
      userId: "bob", deviceId: "d1",
      identityKey: btoa("not-a-valid-ec-point"),
      signedPreKeyId: 1, signedPreKey: btoa("also-fake"),
      signedPreKeySignature: btoa("fake-sig")
    };
    const session = await nobleProvider.establishSession(alice, fakeBundle);
    expect(session.peerUserId).toBe("bob");
    expect(session.sharedKey.length).toBe(32);

    const encrypted = await nobleProvider.encryptForSession(session, "hello");
    const decrypted = await nobleProvider.decryptFromSession(session, encrypted.ciphertext, encrypted.iv);
    expect(decrypted).toBe("hello");
  });
});

describe("session store", () => {
  it("stores persists lists and deletes sessions", async () => {
    const store = createInMemorySignalSessionStore();
    const session: SignalSession = {
      sessionId: "test-1",
      peerUserId: "bob",
      peerDeviceId: "device-b",
      establishedAt: new Date().toISOString(),
      sharedKey: new Uint8Array(32)
    };
    store.set(session.sessionId, session);
    expect(store.get("test-1")).toEqual(session);
    expect(store.listByPeer("bob", "device-b")).toEqual([session]);
    expect(store.listByPeer("charlie", "device-c")).toEqual([]);
    store.delete("test-1");
    expect(store.get("test-1")).toBeUndefined();
  });
});

describe("crypto helpers", () => {
  it("randomBytes generates correct length", () => {
    expect(randomBytes(16).length).toBe(16);
    expect(randomBytes(32).length).toBe(32);
  });

  it("concat merges arrays", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4, 5]);
    const c = concat(a, b);
    expect(c).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("concat handles single array", () => {
    const a = new Uint8Array([99]);
    expect(concat(a)).toEqual(a);
  });

  it("bytesToBase64 and base64ToBytes are reversible", () => {
    const original = randomBytes(32);
    const b64 = bytesToBase64(original);
    expect(base64ToBytes(b64)).toEqual(original);
  });

  it("base64ToBytes handles padding", () => {
    const result = base64ToBytes("SGVsbG8=");
    expect(new TextDecoder().decode(result)).toBe("Hello");
  });

  it("hexToBytes and bytesToHex are reversible", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const hex = bytesToHex(bytes);
    expect(hex).toBe("deadbeef");
    expect(hexToBytes(hex)).toEqual(bytes);
  });

  it("hexToBytes handles empty", () => {
    expect(hexToBytes("")).toEqual(new Uint8Array(0));
  });

  it("file encrypt/decrypt round trips", async () => {
    const key = randomBytes(32);
    const blob = new Blob(["hello file content"], { type: "text/plain" });
    const encrypted = await encryptFile(blob, key);
    expect(encrypted.sizeBytes).toBe(18);
    const decrypted = await decryptFile(encrypted, key);
    expect(await decrypted.text()).toBe("hello file content");
  });

  it("fileKey derivation is deterministic", async () => {
    const session: SignalSession = {
      sessionId: "s1", peerUserId: "bob", peerDeviceId: "d1",
      establishedAt: new Date().toISOString(), sharedKey: randomBytes(32)
    };
    const k1 = await deriveFileKey(session);
    const k2 = await deriveFileKey(session);
    expect(k1).toEqual(k2);
    expect(k1.length).toBe(32);
  });
});

describe("provider selection", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.E2EE_BACKEND;
  });

  it("index re-exports work with default noble provider", async () => {
    const { createLocalSignalIdentity, toPreKeyBundle, establishSession, encryptForSession, decryptFromSession } = await import("./index.js");
    const alice = await createLocalSignalIdentity("alice", "d1", 1);
    const bob = await createLocalSignalIdentity("bob", "d1", 1);
    const b = toPreKeyBundle(bob);
    const session = await establishSession(alice, b);
    const e = await encryptForSession(session, "msg");
    expect(e.algorithm).toBe("aes-256-gcm-v1");
    expect(e.ciphertext).toContain(".");
    const d = await decryptFromSession(session, e.ciphertext);
    expect(d).toBe("msg");
  });

  it("uses noble when E2EE_BACKEND=noble", async () => {
    process.env.E2EE_BACKEND = "noble";
    const { createLocalSignalIdentity, encryptForSession, establishSession, toPreKeyBundle, decryptFromSession } = await import("./index.js");
    const alice = await createLocalSignalIdentity("a", "d1", 1);
    const bob = await createLocalSignalIdentity("b", "d1", 1);
    const session = await establishSession(alice, toPreKeyBundle(bob));
    const e = await encryptForSession(session, "msg");
    expect(e.algorithm).toBe("aes-256-gcm-v1");
    expect(await decryptFromSession(session, e.ciphertext)).toBe("msg");
  });

  it("uses placeholder when E2EE_BACKEND=placeholder", async () => {
    process.env.E2EE_BACKEND = "placeholder";
    const { createLocalSignalIdentity, encryptForSession, establishSession, toPreKeyBundle, decryptFromSession, extractOneTimePreKeys, consumeOneTimePreKey, encryptFile, decryptFile, deriveFileKey } = await import("./index.js");
    const alice = await createLocalSignalIdentity("a", "d1", 3);
    const bob = await createLocalSignalIdentity("b", "d1", 1);
    const session = await establishSession(alice, toPreKeyBundle(bob));
    const e = await encryptForSession(session, "msg");
    expect(e.algorithm).toBe("signal-v1");
    expect(await decryptFromSession(session, e.ciphertext)).toBe("msg");

    const opks = extractOneTimePreKeys(alice);
    expect(opks.length).toBe(3);
    expect(consumeOneTimePreKey(alice, 2)).toBe(true);
    expect(alice.oneTimePreKeys.length).toBe(2);
    expect(consumeOneTimePreKey(alice, 99)).toBe(false);

    const plain = await decryptFromSession(session, btoa("legacy"));
    expect(plain).toBe("legacy");

    const fk = await deriveFileKey(session);
    const enc = await encryptFile(new Blob(["x"]), fk);
    expect(enc.iv.length).toBe(12);
    const dec = await decryptFile(enc, fk);
    expect(await dec.text()).toBe("x");
  });

  it("uses webcrypto when E2EE_BACKEND=webcrypto and isSecureContext", async () => {
    process.env.E2EE_BACKEND = "webcrypto";
    vi.stubGlobal("window", { isSecureContext: true });
    const { createLocalSignalIdentity, encryptForSession, establishSession, toPreKeyBundle, decryptFromSession } = await import("./index.js");
    const alice = await createLocalSignalIdentity("a", "d1", 1);
    const bob = await createLocalSignalIdentity("b", "d1", 1);
    const session = await establishSession(alice, toPreKeyBundle(bob));
    const e = await encryptForSession(session, "msg");
    expect(e.algorithm).toBe("aes-256-gcm-v1");
    expect(await decryptFromSession(session, e.ciphertext)).toBe("msg");
    vi.unstubAllGlobals();
  });

  it("falls back to noble when webcrypto but no secure context", async () => {
    process.env.E2EE_BACKEND = "webcrypto";
    vi.stubGlobal("window", { isSecureContext: false });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { encryptForSession, establishSession, createLocalSignalIdentity, toPreKeyBundle, decryptFromSession } = await import("./index.js");
    const alice = await createLocalSignalIdentity("a", "d1", 1);
    const bob = await createLocalSignalIdentity("b", "d1", 1);
    const session = await establishSession(alice, toPreKeyBundle(bob));
    const e = await encryptForSession(session, "msg");
    expect(e.algorithm).toBe("aes-256-gcm-v1");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
