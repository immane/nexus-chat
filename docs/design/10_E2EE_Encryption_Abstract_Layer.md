---
lang: en
---

# 10 — E2EE Encryption Abstract Layer

> **Document version**: v1.0
> **Last updated**: 2026-07-10
> **Status**: Design (pending implementation)
> **References**:
> - [Security & E2EE Roadmap](../research/security-defense-e2ee-roadmap.md)
> - [System High-Level Architecture](00_System_High_Level_Architecture.md)

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Current State](#2-current-state)
3. [Target Architecture](#3-target-architecture)
4. [Interface Definition (IE2eeProvider)](#4-interface-definition-ie2eeprovider)
5. [Implementation: Placeholder](#5-implementation-placeholder)
6. [Implementation: @noble/* (Production)](#6-implementation-noble-production)
7. [Implementation: Web Crypto API](#7-implementation-web-crypto-api)
8. [File Encryption & Decryption](#8-file-encryption--decryption)
9. [Environment Selection](#9-environment-selection)
10. [Layer 0 Impact Analysis](#10-layer-0-impact-analysis)
11. [Phase 3 Upgrade Path](#11-phase-3-upgrade-path)
12. [Security Considerations](#12-security-considerations)

---

## 1. Motivation

### 1.1 Problem

The current `packages/signal/` exports a complete set of E2EE functions (`createLocalSignalIdentity`, `toPreKeyBundle`, `establishSession`, `encryptForSession`, `decryptForSession`), but the implementation is entirely placeholder:

- **Keys** are random hex strings, not real cryptographic keypairs
- **Encryption** is `btoa(plaintext)` (Base64 encoding), providing **zero confidentiality**
- **Decryption** is `atob(ciphertext)`
- **Session establishment** generates a random session ID without performing any Diffie-Hellman exchange

This means messages marked as "E2EE" are transmitted in plaintext through the server, and the entire E2EE feature set (Task #09, marked "Done" in Phase 1) provides no actual cryptographic protection.

### 1.2 Goal

Replace the placeholder with **real end-to-end encryption** using ECDH key exchange and AES-256-GCM symmetric encryption, while preserving the existing public API so that **zero changes are required in consumer code** (`ChatRoute.tsx`, `signal-helpers.ts`, `MessageRow.tsx`, server routes).

### 1.3 Constraints

- Must work over **plain HTTP** (not just HTTPS/localhost) — rules out `SubtleCrypto` as the sole implementation
- Must support **multiple runtime environments** (Node.js, Electron, browser)
- Must allow **easing migration to Signal Protocol** (X3DH + Double Ratchet) in Phase 3 without breaking the public API
- Must remain **tree-shakable** — unused implementations don't contribute to bundle size

---

## 2. Current State

### 2.1 Placeholder Code (`packages/signal/src/index.ts`)

All 86 lines are pure infrastructure scaffolding:

```typescript
// Key generation: random strings
const randomString = () => crypto.getRandomValues(new Uint8Array(32))
  .reduce((v, b) => v + b.toString(16).padStart(2, "0"), "");

// Encryption: Base64 encoding (NOT encryption)
export const encryptForSession = async (_session: SignalSession, plaintext: string) => ({
  type: "ciphertext" as const,
  ciphertext: btoa(plaintext),
  algorithm: "signal-v1" as const
});

// Decryption: Base64 decoding
export const decryptFromSession = async (_session: SignalSession, ciphertext: string) =>
  atob(ciphertext);
```

### 2.2 Consumer Code (unchanged after refactor)

4 files import from `@nexus-chat/signal`:

| File | Imported Functions |
|------|-------------------|
| `apps/web/src/components/ChatRoute.tsx` | `encryptForSession`, `decryptFromSession`, `establishSession` |
| `apps/web/src/components/signal-helpers.ts` | `createLocalSignalIdentity`, `toPreKeyBundle`, `establishSession`, `encryptForSession`, `decryptFromSession` |
| `apps/web/src/components/MessageRow.tsx` | (via `signal-helpers.ts`) |
| `apps/server/src/domain/signal/service.ts` | (manages PreKey bundle storage, calls `consumeOneTimePreKey`) |

**None of these files will be modified in this refactor.**

### 2.3 Server-Side Infrastructure (already production-ready)

The server handles PreKey bundle storage, consumption, and session metadata tracking:

- `POST /signal/prekey-bundles` — upload public key bundle (identity key, signed prekey, OPKs)
- `GET /signal/prekey-bundles/:userId/:deviceId` — fetch bundle
- `POST /signal/prekey-bundles/:userId/:deviceId/consume` — consume one-time prekey
- `POST /signal/sessions` — record session metadata
- `GET /signal/sessions` — list user sessions

These store **opaque strings** (keys as hex/JWK). The server never interprets key material. This makes the server fully compatible with any cryptographic implementation — it's a transparent store-and-forward layer.

---

## 3. Target Architecture

### 3.1 File Structure

```
packages/signal/
├── src/
│   ├── types.ts           # Shared types + IE2eeProvider interface
│   ├── placeholder.ts     # Current Base64 impl (preserved as fallback, @deprecated)
│   ├── noble.ts           # @noble/curves + @noble/ciphers (production, HTTP-compatible)
│   ├── webcrypto.ts       # SubtleCrypto (production, HTTPS/localhost-only)
│   ├── crypto.ts          # File encryption/decryption helpers (shared by all providers)
│   └── index.ts           # Provider selection + re-export
├── package.json           # + @noble/curves, @noble/ciphers
└── tsconfig.json
```

### 3.2 Layer Diagram

```
┌──────────────────────────────────────────────────────────┐
│                     Consumer Layer                         │
│  ChatRoute.tsx    signal-helpers.ts    MessageRow.tsx     │
│  (import { encryptForSession, ... } from "@nexus-chat/signal")│
└────────────────────┬─────────────────────────────────────┘
                     │   Imports (unchanged)
┌────────────────────┴─────────────────────────────────────┐
│              packages/signal/src/index.ts                  │
│         (provider selection + re-export)                   │
│                                                           │
│  if E2EE_BACKEND=noble   → nobleProvider                  │
│  if E2EE_BACKEND=webcrypto → webcryptoProvider            │
│  else                    → placeholderProvider             │
└──────┬────────────┬────────────┬──────────────────────────┘
       │            │            │
┌──────┴──┐  ┌──────┴──┐  ┌─────┴─────┐
│noble.ts │  │webcrypto│  │placeholder│
│@noble/* │  │Subtle   │  │btoa/atob  │
│ECDH +   │  │Crypto   │  │random hex │
│AES-GCM  │  │P-256 +  │  │(Phase 3   │
│         │  │AES-GCM  │  │  fallback)│
└─────────┘  └─────────┘  └───────────┘
       │            │            │
       └────────────┼────────────┘
                    │
           ┌────────┴────────┐
           │    crypto.ts     │
           │ encryptFile()    │
           │ decryptFile()    │
           └─────────────────┘
```

---

## 4. Interface Definition (IE2eeProvider)

### 4.1 Type Changes

The current `LocalSignalIdentity` uses `string` for all key fields. The improved version uses `Uint8Array` for raw key material, with serialization helpers:

```typescript
// types.ts — shared type definitions

export type LocalSignalIdentity = {
  userId: string;
  deviceId: string;
  identityKeyPublic: Uint8Array;       // was: string
  identityKeyPrivate: Uint8Array;      // was: string
  signedPreKeyPublic: Uint8Array;      // was: string
  signedPreKeyPrivate: Uint8Array;     // was: string
  signedPreKeySignature: Uint8Array;   // was: string
  oneTimePreKeys: Array<{
    id: number;
    publicKey: Uint8Array;             // was: string
    privateKey: Uint8Array;            // was: string
  }>;
};

export type SignalSession = {
  sessionId: string;
  peerUserId: string;
  peerDeviceId: string;
  establishedAt: string;
  sharedKey: Uint8Array;               // NEW: ECDH-derived symmetric key
};

export type SignalSessionStore = {
  get(sessionId: string): SignalSession | undefined;
  set(sessionId: string, session: SignalSession): void;
  listByPeer(userId: string, deviceId: string): SignalSession[];
  delete(sessionId: string): void;
};

export type E2eeCiphertext = {
  type: "ciphertext";
  ciphertext: string;                  // Base64-encoded encrypted bytes
  algorithm: string;                   // "aes-256-gcm-v1" or "signal-v1"
  iv: string;                          // NEW: Base64-encoded 12-byte IV (GCM nonce)
};

export type EncryptedFile = {
  ciphertext: Uint8Array;              // Encrypted file bytes
  iv: Uint8Array;                      // 12-byte IV
  originalName: string;                // Preserved for display
  mimeType: string;
  sizeBytes: number;                   // Original plaintext size
};

export type FileEncryptionKey = Uint8Array;  // 32-byte symmetric key
```

### 4.2 Provider Interface

```typescript
// types.ts — interface

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
```

All methods are `async` to accommodate both synchronous placeholder logic and asynchronous `SubtleCrypto` / `@noble/*` operations.

### 4.3 Backward Compatibility

The existing function signatures `encryptForSession(session, text)` and `decryptFromSession(session, ciphertext)` are preserved in the re-export layer. The `ciphertext` field in `E2eeCiphertext` wraps the additional `iv` and `algorithm` metadata for the API boundary:

```typescript
// index.ts — backward-compatible wrapper

export const encryptForSession = async (
  session: SignalSession, plaintext: string
) => provider.encryptForSession(session, plaintext);

export const decryptFromSession = async (
  session: SignalSession, ciphertext: string
) => {
  const wrapper = JSON.parse(ciphertext) as E2eeCiphertextWrapper;
  return provider.decryptFromSession(session, wrapper.ciphertext, wrapper.iv);
};
```

---

## 5. Implementation: Placeholder

### 5.1 Purpose

Preserves the current Base64-based implementation as a **development fallback and reference stub**. All functions are marked `@deprecated` with clear warnings that this provides zero security.

### 5.2 File: `placeholder.ts`

```typescript
/** @deprecated Phase 3 placeholder — NOT SECURE. Uses Base64 encoding, not encryption. */
export const placeholderProvider: IE2eeProvider = {
  async createLocalIdentity(userId, deviceId, preKeyCount = 20) {
    return {
      userId,
      deviceId,
      identityKeyPublic: hexToBytes(randomString()),
      identityKeyPrivate: hexToBytes(randomString()),
      signedPreKeyPublic: hexToBytes(randomString()),
      signedPreKeyPrivate: hexToBytes(randomString()),
      signedPreKeySignature: hexToBytes(randomString()),
      oneTimePreKeys: Array.from({ length: preKeyCount }, (_, i) => ({
        id: i + 1,
        publicKey: hexToBytes(randomString()),
        privateKey: hexToBytes(randomString()),
      })),
    };
  },

  async establishSession(identity, peerBundle, sessionStore) {
    const session: SignalSession = {
      sessionId: `signal:${peerBundle.userId}:${peerBundle.deviceId}:${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`,
      peerUserId: peerBundle.userId,
      peerDeviceId: peerBundle.deviceId,
      establishedAt: new Date().toISOString(),
      sharedKey: new Uint8Array(32), // zeros — no real key derivation
    };
    sessionStore?.set(session.sessionId, session);
    return session;
  },

  async encryptForSession(_session, plaintext) {
    return {
      type: "ciphertext",
      ciphertext: btoa(plaintext),          // ⚠️ NOT encrypted
      algorithm: "signal-v1",
      iv: btoa(new Uint8Array(12)),          // dummy 12 zero bytes
    };
  },

  async decryptFromSession(_session, ciphertext, _iv) {
    return atob(ciphertext);                 // ⚠️ NOT decrypted
  },

  // ... file methods return placeholder (no actual encryption)
};
```

---

## 6. Implementation: @noble/* (Production)

### 6.1 Why @noble/*

| Requirement | @noble/* | SubtleCrypto |
|------------|----------|-------------|
| Works over plain HTTP | ✅ Pure JS | ❌ Requires secure context |
| ECDH P-256 key exchange | ✅ `@noble/curves` | ✅ `SubtleCrypto` |
| AES-256-GCM encrypt/decrypt | ✅ `@noble/ciphers` | ✅ `SubtleCrypto` |
| Bundle size | ~15 KB gzip | 0 KB (built-in) |
| Tree-shakable | ✅ | N/A |
| License | MIT | W3C standard |

### 6.2 Dependencies

```json
{
  "dependencies": {
    "@noble/curves": "^1.4",
    "@noble/ciphers": "^0.6"
  }
}
```

### 6.3 File: `noble.ts` (Key Sections)

**Identity Creation (ECDH Keypair)**

```typescript
import { p256 } from "@noble/curves/p256";

async createLocalIdentity(userId, deviceId, preKeyCount = 20) {
  const identityPriv = p256.utils.randomPrivateKey();
  const identityPub = p256.getPublicKey(identityPriv);

  const signedPrePriv = p256.utils.randomPrivateKey();
  const signedPrePub = p256.getPublicKey(signedPrePriv);
  const sig = await p256.sign(signedPrePub, identityPriv);

  const opks = Array.from({ length: preKeyCount }, (_, i) => {
    const priv = p256.utils.randomPrivateKey();
    return {
      id: i + 1,
      publicKey: p256.getPublicKey(priv),
      privateKey: priv,
    };
  });

  return {
    userId, deviceId,
    identityKeyPublic: identityPub,
    identityKeyPrivate: identityPriv,
    signedPreKeyPublic: signedPrePub,
    signedPreKeyPrivate: signedPrePriv,
    signedPreKeySignature: sig,
    oneTimePreKeys: opks,
  };
}
```

Note: `@noble/curves` uses **compact (33-byte) public key** format by default. The `toPreKeyBundle` export serializes to Base64 for server storage.

**Session Establishment (ECDH)**

```typescript
async establishSession(identity, peerBundle, sessionStore) {
  // Use our identity private key + peer's identity public key
  const sharedSecret = p256.getSharedSecret(
    identity.identityKeyPrivate,
    base64ToBytes(peerBundle.identityKey)
  );

  // Derive AES-256 key via HKDF (SHA-256)
  const sharedKey = hkdfSha256(sharedSecret, "nexus-chat-e2ee-v1", 32);

  const session = {
    sessionId: `signal:${peerBundle.userId}:${peerBundle.deviceId}:${randomId()}`,
    peerUserId: peerBundle.userId,
    peerDeviceId: peerBundle.deviceId,
    establishedAt: new Date().toISOString(),
    sharedKey,
  };

  sessionStore?.set(session.sessionId, session);
  return session;
}
```

**Message Encryption (AES-256-GCM)**

```typescript
import { gcm } from "@noble/ciphers/aes";

async encryptForSession(session, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const cipher = gcm(session.sharedKey, iv);
  const ciphertext = cipher.encrypt(encoder.encode(plaintext));

  return {
    type: "ciphertext",
    ciphertext: bytesToBase64(ciphertext),
    algorithm: "aes-256-gcm-v1",
    iv: bytesToBase64(iv),
  };
}
```

**Message Decryption**

```typescript
async decryptFromSession(session, ciphertextB64, ivB64) {
  const ciphertext = base64ToBytes(ciphertextB64);
  const iv = base64ToBytes(ivB64);
  const cipher = gcm(session.sharedKey, iv);
  const plaintext = cipher.decrypt(ciphertext);

  return new TextDecoder().decode(plaintext);
}
```

### 6.4 Key Characteristics

| Property | Value |
|----------|-------|
| Algorithm | ECDH P-256 + AES-256-GCM |
| Key exchange | 1-way DH (identity key only, simplified from X3DH) |
| Nonce | 12-byte random IV per message |
| Authentication | GCM built-in (ciphertext + auth tag) |
| HKDF salt | Fixed context string `"nexus-chat-e2ee-v1"` |
| Forward secrecy | ❌ (session key is static; Double Ratchet in Phase 3) |
| Post-compromise recovery | ❌ (Phase 3) |

---

## 7. Implementation: Web Crypto API

### 7.1 File: `webcrypto.ts`

Identical functionality to `noble.ts`, but uses `window.crypto.subtle`:

```typescript
export const webcryptoProvider: IE2eeProvider = {
  async createLocalIdentity(userId, deviceId, preKeyCount = 20) {
    const identityKey = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
    );
    // ... same structure, export to raw Uint8Array via exportKey("raw")
  },

  async encryptForSession(session, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", session.sharedKey,
      { name: "AES-GCM" }, false, ["encrypt"]);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext)
    );
    // ...
  },
  // ...
};
```

### 7.2 Environment Detection

```typescript
function isSecureContext(): boolean {
  return typeof window !== "undefined" && window.isSecureContext;
}
```

Only available on `localhost`, `127.0.0.1`, or HTTPS origins. Falls back to `@noble/*` otherwise.

---

## 8. File Encryption & Decryption

### 8.1 File: `crypto.ts`

Shared by all three providers. Uses the session's `sharedKey` (or a derived file-specific key) for AES-256-GCM:

```typescript
import { gcm } from "@noble/ciphers/aes";

export async function encryptFile(
  blob: Blob,
  key: FileEncryptionKey
): Promise<EncryptedFile> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buffer = await blob.arrayBuffer();
  const cipher = gcm(key, iv);
  const ciphertext = cipher.encrypt(new Uint8Array(buffer));

  return {
    ciphertext,
    iv,
    originalName: (blob as File).name ?? "unknown",
    mimeType: blob.type,
    sizeBytes: buffer.byteLength,
  };
}

export async function decryptFile(
  encrypted: EncryptedFile,
  key: FileEncryptionKey
): Promise<Blob> {
  const cipher = gcm(key, encrypted.iv);
  const plaintext = cipher.decrypt(encrypted.ciphertext);
  return new Blob([plaintext], { type: encrypted.mimeType });
}
```

### 8.2 File Key Derivation

```typescript
export async function deriveFileKey(
  session: SignalSession
): Promise<FileEncryptionKey> {
  // HKDF-extract: derive a separate key for files from the session key
  return hkdfSha256(session.sharedKey, "nexus-chat-file-key-v1", 32);
}
```

### 8.3 Flow for E2EE Attachments

```
Sender:
  1. select file
  2. deriveFileKey(session) → fileKey
  3. encryptFile(blob, fileKey) → { ciphertext, iv, ... }
  4. PUT /dev-upload/:fileId  (body = ciphertext, headers include iv)
  5. send message with attachment ref { fileId, name, scanStatus: "skipped" }

Receiver:
  1. GET /dev-download/:fileId → encrypted blob
  2. deriveFileKey(session) → fileKey
  3. decryptFile(encryptedBlob, fileKey) → Blob
  4. createObjectURL(blob) → render <img>
```

---

## 9. Environment Selection

### 9.1 Configuration

```typescript
// index.ts

import { placeholderProvider } from "./placeholder.js";
import { nobleProvider } from "./noble.js";
import { webcryptoProvider } from "./webcrypto.js";

function selectProvider(): IE2eeProvider {
  const backend = typeof process !== "undefined"
    ? process.env.E2EE_BACKEND
    : undefined;

  if (backend === "noble") return nobleProvider;

  if (backend === "webcrypto") {
    if (typeof window !== "undefined" && window.isSecureContext) {
      return webcryptoProvider;
    }
    console.warn("[E2EE] Web Crypto requires secure context (HTTPS/localhost)." +
      " Falling back to @noble/*.");
  }

  if (backend === "placeholder") return placeholderProvider;

  // Default: prefer @noble/* (works everywhere)
  return nobleProvider;
}

const provider = selectProvider();

// Re-export with the same function names (backward compatible)
export const createLocalSignalIdentity = (...args: Parameters<IE2eeProvider["createLocalIdentity"]>) =>
  provider.createLocalIdentity(...args);

export const toPreKeyBundle = (...args: Parameters<IE2eeProvider["toPreKeyBundle"]>) =>
  provider.toPreKeyBundle(...args);

export const establishSession = (...args: Parameters<IE2eeProvider["establishSession"]>) =>
  provider.establishSession(...args);

export const encryptForSession = (...args: Parameters<IE2eeProvider["encryptForSession"]>) =>
  provider.encryptForSession(...args);

export const decryptFromSession = (...args: Parameters<IE2eeProvider["decryptFromSession"]>) =>
  provider.decryptFromSession(...args);

export const encryptFile = (...args: Parameters<IE2eeProvider["encryptFile"]>) =>
  provider.encryptFile(...args);

export const decryptFile = (...args: Parameters<IE2eeProvider["decryptFile"]>) =>
  provider.decryptFile(...args);

export const deriveFileKey = (...args: Parameters<IE2eeProvider["deriveFileKey"]>) =>
  provider.deriveFileKey(...args);
```

### 9.2 Default Behavior

| Environment | Default Provider | Reason |
|------------|-----------------|--------|
| Browser, HTTPS | `nobleProvider` | Consistent behavior; `E2EE_BACKEND=webcrypto` opt-in |
| Browser, HTTP | `nobleProvider` | Web Crypto unavailable in insecure context |
| Node.js | `nobleProvider` | `SubtleCrypto` available but `@noble/*` is more portable |
| CI (test) | `placeholderProvider` | Tests should set `E2EE_BACKEND=placeholder` |

---

## 10. Layer 0 Impact Analysis

### 10.1 Files Unchanged

| File | Reason |
|------|--------|
| `apps/server/src/domain/signal/service.ts` | Stores opaque key strings (now JWK/Base64 instead of hex — transparent) |
| `apps/server/src/http/routes.ts` | Routes remain identical |
| `apps/web/src/components/ChatRoute.tsx` | Imports unchanged |
| `apps/web/src/components/signal-helpers.ts` | Imports unchanged |
| `apps/web/src/components/MessageRow.tsx` | Imports unchanged |
| `apps/web/src/stores/domain.ts` | No E2EE-related state changes |
| `apps/tui/src/lib/api.ts` | TUI uses REST, not Signal directly |
| `packages/shared/` | Schemas already support ciphertext content |

### 10.2 Files Changed (Minimal)

| File | Change | Lines |
|------|--------|-------|
| `packages/signal/package.json` | Add `@noble/curves`, `@noble/ciphers` | +2 |
| `packages/signal/src/types.ts` | Extract types, add `IE2eeProvider`, add `sharedKey` to `SignalSession` | ~80 |
| `packages/signal/src/placeholder.ts` | Move current code, add `@deprecated` comments | ~100 |
| `packages/signal/src/noble.ts` | New: `@noble/*` implementation | ~120 |
| `packages/signal/src/webcrypto.ts` | New: SubtleCrypto implementation | ~120 |
| `packages/signal/src/crypto.ts` | New: file encrypt/decrypt helpers | ~60 |
| `packages/signal/src/index.ts` | Rewrite: provider selection + re-export | ~50 |
| `apps/web/src/components/ChatComposer.tsx` | Remove `!isE2e` condition hiding 📎 | -2 |
| `apps/web/src/hooks/useAttachments.ts` | Call `encryptFile()` before PUT in E2EE mode | +5 |
| `apps/web/src/components/MessageRow.tsx` | Call `decryptFile()` after GET in E2EE mode | +5 |

**Total: ~550 new/rewritten lines, -2 lines removed. 3 consumer files touched with ~12 lines added.**

---

## 11. Phase 3 Upgrade Path

### 11.1 Migration Strategy

When `@signalapp/libsignal` is integrated in Phase 3:

1. Add a new provider `libsignal.ts` implementing `IE2eeProvider`
2. `Signal Session` type gains additional fields (`ratchetState`, `messageKeys`)
3. Change `E2EE_BACKEND=libsignal` environment variable
4. All consumer code remains **completely unchanged**

### 11.2 What Changes

| Component | Phase 1-2 (now) | Phase 3 (future) |
|-----------|-----------------|------------------|
| Key exchange | 1-way DH (identity key) | X3DH (3-way DH: identity + signed prekey + OPK) |
| Key rotation | Static (per-session) | Double Ratchet (per-message) |
| Forward secrecy | No | Yes |
| Post-compromise recovery | No | Yes (DH ratchet self-healing) |
| Group messaging | Not implemented | Sender Key distribution |
| License | MIT (@noble/*) | AGPL-3.0 (libsignal) |

### 11.3 Provider Implementation Surface

```typescript
// Phase 3: libsignal.ts
export const libsignalProvider: IE2eeProvider = {
  async createLocalIdentity(userId, deviceId, preKeyCount) {
    // Use libsignal's IdentityKeyPair.generate()
  },
  async establishSession(identity, peerBundle, store) {
    // Use libsignal's processPreKeyBundle() → X3DH
  },
  async encryptForSession(session, plaintext) {
    // Use libsignal's sessionCipher.encrypt() → Double Ratchet advance
  },
  async decryptFromSession(session, ciphertext) {
    // Use libsignal's sessionCipher.decrypt()
  },
  // file methods remain identical (AES-GCM over the session key)
};
```

---

## 12. Security Considerations

### 12.1 Threat Model Coverage (Phase 1-2)

| Threat | Mitigation | Status |
|--------|-----------|--------|
| Server compromise reads messages | ECDH: server only stores public keys and ciphertext | ✅ |
| Man-in-the-middle (network) | GCM authentication tag prevents tampering | ✅ |
| Message replay | Random IV per message prevents identical plaintext → identical ciphertext | ✅ |
| Key compromise reads past messages | ❌ No forward secrecy (static session key) | Phase 3 |
| Key compromise enables future messages | ❌ No DH ratchet self-healing | Phase 3 |
| Client compromise (key extraction) | Out of scope (OS-level concern) | — |

### 12.2 Known Limitations

1. **Forward secrecy**: If an attacker obtains the session's `sharedKey`, they can decrypt all messages in that session. Phase 3's Double Ratchet addresses this.
2. **Identity verification**: There is no safety number / QR-code verification of peer identity keys. A MITM who controls the server could substitute PreKey bundles and perform a MITM attack in Phase 1-2. Phase 3 will add safety number display.
3. **Session persistence**: `sharedKey` is stored in memory (`Map`). Browser refresh requires re-establishing the session (server stores metadata, not keys — this is by design).

### 12.3 Key Management

- Private keys **never leave the client** (by construction: `identityKeyPrivate` is a `Uint8Array` only used locally for ECDH)
- Public keys are serialized to Base64 and stored server-side in PreKey bundles
- Each E2EE DM has one `SignalSession` with one `sharedKey`
- Sessions are per peer-pair, not per message (Phase 3 will add per-message ratchet)
