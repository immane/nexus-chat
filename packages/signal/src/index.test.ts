import { describe, expect, it } from "vitest";
import { consumeOneTimePreKey, createInMemorySignalSessionStore, createLocalSignalIdentity, decryptFromSession, encryptForSession, establishSession, extractOneTimePreKeys, toPreKeyBundle } from "./index.js";

describe("signal facade", () => {
  it("creates identities bundles sessions and reversible placeholder ciphertext", async () => {
    const alice = createLocalSignalIdentity("alice", "device-a", 2);
    const bob = createLocalSignalIdentity("bob", "device-b", 1);
    const bundle = toPreKeyBundle(bob);
    const session = establishSession(alice, bundle);
    const encrypted = await encryptForSession(session, "secret");
    expect(bundle.oneTimePreKeyId).toBe(1);
    expect(session.peerUserId).toBe("bob");
    expect(encrypted.algorithm).toBe("signal-v1");
    await expect(decryptFromSession(session, encrypted.ciphertext)).resolves.toBe("secret");
  });

  it("extracts and consumes one-time prekeys", () => {
    const alice = createLocalSignalIdentity("alice", "device-a", 3);
    const extracted = extractOneTimePreKeys(alice);
    expect(extracted).toHaveLength(3);
    expect(consumeOneTimePreKey(alice, 2)).toBe(true);
    expect(alice.oneTimePreKeys).toHaveLength(2);
    expect(alice.oneTimePreKeys.find((pk) => pk.id === 2)).toBeUndefined();
    expect(consumeOneTimePreKey(alice, 99)).toBe(false);
  });

  it("stores persists and lists signal sessions", () => {
    const store = createInMemorySignalSessionStore();
    const alice = createLocalSignalIdentity("alice", "device-a", 1);
    const bobBundle = toPreKeyBundle(createLocalSignalIdentity("bob", "device-b", 1));
    const session = establishSession(alice, bobBundle, store);
    expect(store.get(session.sessionId)).toEqual(session);
    expect(store.listByPeer("bob", "device-b")).toEqual([session]);
    expect(store.listByPeer("charlie", "device-c")).toEqual([]);
    store.delete(session.sessionId);
    expect(store.get(session.sessionId)).toBeUndefined();
  });
});
