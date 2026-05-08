/**
 * Bot crypto: Ed25519 sign/verify, canonical JSON, bcrypt password hashing.
 *
 * Ed25519 via @noble/ed25519 v2 (pure JS). Async API uses crypto.subtle.digest
 * for SHA-512 — Workers expose Web Crypto, no Node `crypto` shim needed.
 *
 * bcrypt via bcryptjs (pure JS). 10 rounds (~100ms in Worker isolate; well
 * under the 30s CPU limit).
 */

import * as ed from '@noble/ed25519';
import bcrypt from 'bcryptjs';

/** Base64 encoder for Uint8Arrays (Workers don't ship Buffer in all paths). */
function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hexToBytes: odd hex string length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

const enc = new TextEncoder();

/** Sign a string payload with the bot's Ed25519 private key (raw 32-byte seed in hex). Returns base64. */
export async function botSign(privKeyHex: string, payload: string): Promise<string> {
  const priv = hexToBytes(privKeyHex);
  if (priv.length !== 32) throw new Error('botSign: private key must be 32 bytes');
  const sig = await ed.signAsync(enc.encode(payload), priv);
  return b64encode(sig);
}

/** Verify a base64 Ed25519 signature against a raw-32-byte public key in hex. */
export async function verifyDesktopSignature(
  pubkeyHex: string,
  payload: string,
  sigB64: string
): Promise<boolean> {
  try {
    const pub = hexToBytes(pubkeyHex);
    if (pub.length !== 32) return false;
    const sig = b64decode(sigB64);
    if (sig.length !== 64) return false;
    return await ed.verifyAsync(sig, enc.encode(payload), pub);
  } catch {
    return false;
  }
}

/**
 * Stable JSON canonicalization: sort object keys lexicographically at every depth,
 * preserve array order. Used in signed payloads so signer & verifier hash the same bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]));
  return '{' + parts.join(',') + '}';
}

/**
 * Build the canonical pre-image the bot signs over for an outbound inbox message.
 * Mirror function exists on the desktop side.
 */
export function botMessagePreimage(pairingId: string, seq: number, kind: string, payload: unknown): string {
  return `v2|${pairingId}|${seq}|${kind}|${canonicalJson(payload)}`;
}

/** bcrypt the plaintext password. 10 rounds matches packages/shared/src/crypto.ts. */
export async function bcryptHash(plain: string): Promise<string> {
  // bcryptjs is sync; wrapping in a promise makes the call site async-uniform.
  return bcrypt.hashSync(plain, 10);
}

/**
 * Generate an 8-char pair code from a no-ambiguous-chars alphabet.
 * ~41 bits of entropy — fine for a 5-minute TTL.
 */
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generatePairCode(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < 8; i++) out += PAIR_CODE_ALPHABET[buf[i] % PAIR_CODE_ALPHABET.length];
  return out;
}

/** Generate a UUIDv4. Workers expose crypto.randomUUID. */
export function generatePairingId(): string {
  return crypto.randomUUID();
}
