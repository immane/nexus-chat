---
lang: en
phase: 1
status: done
---

# 27 — Phase 1 — E2EE Real Encryption Implementation

## Goal

Replace the current placeholder Base64 "encryption" in `packages/signal/` with real ECDH key exchange and AES-256-GCM symmetric encryption, refactored into an `IE2eeProvider` interface with three swappable implementations.

## Current State

`packages/signal/src/index.ts` provides a complete E2EE API surface (`createLocalSignalIdentity`, `toPreKeyBundle`, `establishSession`, `encryptForSession`, `decryptFromSession`) but the implementation is entirely fake:

- Keys are random hex strings (`randomString()`), not real ECDH keypairs
- Encryption is `btoa(plaintext)` — Base64 encoding with zero confidentiality
- Decryption is `atob(ciphertext)`
- Session establishment generates a random session ID without Diffie-Hellman exchange

All consumer code (`ChatRoute.tsx`, `signal-helpers.ts`, `MessageRow.tsx`) imports from `@nexus-chat/signal` and will require **zero changes** after this refactoring.

## Scope

### 27.1 Extract Shared Types (`packages/signal/src/types.ts`)

- Move `LocalSignalIdentity`, `SignalSession`, `SignalSessionStore` from `index.ts`
- Add `IE2eeProvider` interface (7 methods)
- Add `E2eeCiphertext`, `EncryptedFile`, `FileEncryptionKey` types
- Change key fields from `string` to `Uint8Array` in `LocalSignalIdentity`
- Add `sharedKey: Uint8Array` to `SignalSession`

### 27.2 Placeholder Provider (`packages/signal/src/placeholder.ts`)

- Move current code from `index.ts` (with existing large header comment block and `@deprecated` annotations)
- Implement `IE2eeProvider` interface
- Mark every method `@deprecated` with reference to Task #27
- File only used when `E2EE_BACKEND=placeholder` (default in dev, for CI testing)

### 27.3 @noble/* Provider (`packages/signal/src/noble.ts`) — Production

- Dependencies: `@noble/curves` (P-256 ECDH), `@noble/ciphers` (AES-256-GCM)
- `createLocalIdentity`: `p256.utils.randomPrivateKey()` → ECDH keypair
- `establishSession`: `p256.getSharedSecret(priv, peerPub)` → HKDF derive AES-256 key
- `encryptForSession`: `gcm(sharedKey, iv).encrypt(plaintext)`
- `decryptFromSession`: `gcm(sharedKey, iv).decrypt(ciphertext)`
- Works over plain HTTP (pure JS, no secure context required)
- MIT license, ~15 KB gzip

### 27.4 Web Crypto Provider (`packages/signal/src/webcrypto.ts`) — HTTPS only

- `createLocalIdentity`: `crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" })`
- `establishSession`: `crypto.subtle.deriveBits({ name: "ECDH", public: peerKey })`
- `encryptForSession`: `crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext)`
- `decryptForSession`: `crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)`
- Requires `window.isSecureContext === true` (localhost / HTTPS)
- Zero bundle size (built-in)

### 27.5 File Encryption (`packages/signal/src/crypto.ts`)

- `encryptFile(blob, key)`: AES-256-GCM over file bytes → `{ ciphertext, iv, originalName, mimeType, sizeBytes }`
- `decryptFile(encryptedBlob, key)`: AES-256-GCM decrypt → `Blob`
- `deriveFileKey(session)`: HKDF from `session.sharedKey` with context `"nexus-chat-file-key-v1"`
- Shared by all three providers (uses `@noble/ciphers` internally for consistency)

### 27.6 Provider Selection & Re-export (`packages/signal/src/index.ts`)

- Rewrite `index.ts` to select provider based on `E2EE_BACKEND` env var
- Re-export all functions with same names (backward compatible)
- Default: `nobleProvider` (works everywhere)

### 27.7 Enable E2EE File Attachments (3 consumer files)

- `ChatComposer.tsx`: Remove `!isE2e` condition hiding 📎 button (~2 lines)
- `useAttachments.ts`: Call `encryptFile()` before PUT in E2EE mode (~5 lines)
- `MessageRow.tsx`: Call `decryptFile()` after GET in E2EE mode (~5 lines)

### 27.8 Install Dependencies

- `packages/signal/package.json`: Add `@noble/curves` ^1.4, `@noble/ciphers` ^0.6

### 27.9 Update Upstream Documentation

- Update `docs/ai/context.md` Section 6.5 stats
- Update `docs/README.md` design docs table if needed

## Non-Goals

- No X3DH or Double Ratchet (deferred to Phase 3, Signal Protocol, separate AGPL-3.0 branch)
- No server-side changes (PreKey endpoints already production-ready)
- No P2P-specific changes (shared encrypt/decrypt functions auto-apply)
- No group E2EE (Phase 2)

## Files Changed

| File | Change | Lines |
|------|--------|-------|
| `packages/signal/package.json` | Add `@noble/curves`, `@noble/ciphers` | +2 |
| `packages/signal/src/types.ts` | **New**: shared types + `IE2eeProvider` interface | ~80 |
| `packages/signal/src/placeholder.ts` | Move from `index.ts`, add `@deprecated`, implement `IE2eeProvider` | ~100 |
| `packages/signal/src/noble.ts` | **New**: `@noble/*` ECDH + AES-256-GCM | ~120 |
| `packages/signal/src/webcrypto.ts` | **New**: SubtleCrypto ECDH + AES-256-GCM | ~120 |
| `packages/signal/src/crypto.ts` | **New**: file encrypt/decrypt helpers | ~60 |
| `packages/signal/src/index.ts` | Rewrite: provider selection + re-export | ~50 |
| `apps/web/src/components/ChatComposer.tsx` | Remove `!isE2e` condition hiding 📎 | -2 |
| `apps/web/src/hooks/useAttachments.ts` | Call `encryptFile()` before PUT in E2EE mode | +5 |
| `apps/web/src/components/MessageRow.tsx` | Call `decryptFile()` after GET in E2EE mode | +5 |

**Total: ~550 new/rewritten lines, 3 consumer files with ~12 lines added.**

## Server Impact

**None.** All PreKey bundle storage, session metadata, and ciphertext relay endpoints remain unchanged. The server stores opaque strings (keys as Base64, ciphertext as Base64) regardless of the crypto implementation.

## P2P Impact

**None.** `encryptForSession` and `decryptFromSession` are shared by both relay and P2P paths. Changing their implementation automatically applies to both transport modes.

## Acceptance Criteria

- [x] `pnpm --filter @nexus-chat/signal typecheck` passes
- [x] `pnpm --filter @nexus-chat/signal test` passes (33 tests, updated for `Uint8Array` types and async API)
- [x] `pnpm --filter @nexus-chat/server typecheck` passes
- [x] `pnpm --filter @nexus-chat/web typecheck` passes
- [x] E2EE messages use real AES-256-GCM ciphertext (`encryptForSession` returns `algorithm: "aes-256-gcm-v1"` with IV)
- [x] `E2EE_BACKEND=noble` uses `@noble/*` provider (default, no env needed)
- [x] `E2EE_BACKEND=webcrypto` uses SubtleCrypto provider (verified in test with mocked `window.isSecureContext`)
- [x] `E2EE_BACKEND=placeholder` uses Base64 stub (current behavior preserved)
- [x] E2EE file attachments: 📎 button visible in E2EE mode; `encryptFile`/`decryptFile` tested with all three providers
- [x] Coverage: signal package 100% across all metrics

## Design Reference

- [10 — E2EE Encryption Abstract Layer](../design/10_E2EE_Encryption_Abstract_Layer.md)
- [00 — System High-Level Architecture](../design/00_System_High_Level_Architecture.md)
