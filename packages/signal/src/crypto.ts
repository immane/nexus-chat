/**
 * E2EE Cryptographic Helpers (Shared Across Providers)
 *
 * Low-level crypto primitives and file encryption utilities used by
 * noble.ts, webcrypto.ts, and placeholder.ts.
 *
 * Functions:
 * - randomBytes: wrappers around crypto.getRandomValues
 * - concat, bytesToBase64, base64ToBytes, hexToBytes, bytesToHex: byte encoding
 * - hkdfSha256: key derivation via Web Crypto API (used for session key derivation)
 * - encryptFile/decryptFile: AES-256-GCM file encryption via @noble/ciphers
 * - deriveFileKey: session-based HKDF key derivation for file encryption
 *
 * Design Decision:
 * File encryption uses @noble/ciphers (not Web Crypto SubtleCrypto) because
 * it works consistently across all providers including the noble backend,
 * and avoids the Blob-to-ArrayBuffer overhead that Web Crypto requires.
 */
import { gcm } from "@noble/ciphers/aes.js";
import type { EncryptedFile, FileEncryptionKey, SignalSession } from "./types.js";

const randomBytes = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));

const concat = (...arrays: Uint8Array[]): Uint8Array => {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { result.set(a, offset); offset += a.length; }
  return result;
};

const bytesToBase64 = (bytes: Uint8Array): string =>
  btoa([...bytes].map((b) => String.fromCharCode(b)).join(""));

const base64ToBytes = (base64: string): Uint8Array => {
  const bin = atob(base64);
  return new Uint8Array([...bin].map((c) => c.charCodeAt(0)));
};

const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};

const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const hkdfSha256 = async (ikm: Uint8Array, salt: string, length: number): Promise<Uint8Array> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", ikm.buffer as ArrayBuffer, { name: "HKDF" }, false, ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(salt), info: encoder.encode(salt) },
    key, length * 8
  );
  return new Uint8Array(derived);
};

export { randomBytes, concat, bytesToBase64, base64ToBytes, hexToBytes, bytesToHex, hkdfSha256 };

export async function encryptFile(blob: Blob, key: FileEncryptionKey): Promise<EncryptedFile> {
  const iv = randomBytes(12);
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const cipher = gcm(key, iv);
  const ciphertext = cipher.encrypt(buffer);
  return { ciphertext, iv, originalName: (blob as File).name ?? "unknown", mimeType: blob.type, sizeBytes: buffer.length };
}

export async function decryptFile(encrypted: EncryptedFile, key: FileEncryptionKey): Promise<Blob> {
  const cipher = gcm(key, encrypted.iv);
  const plaintext = cipher.decrypt(encrypted.ciphertext);
  return new Blob([plaintext], { type: encrypted.mimeType });
}

export async function deriveFileKey(session: SignalSession): Promise<FileEncryptionKey> {
  return hkdfSha256(session.sharedKey, "nexus-chat-file-key-v1", 32);
}
