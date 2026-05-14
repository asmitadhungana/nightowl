/**
 * NightOwl Identity & Bot Verification (v2 Friend Lock)
 *
 * Ed25519 keypair management for two parties:
 *   1. Per-install desktop identity — generated on first v2 use, stored at
 *      ~/Library/Application Support/NightOwl/.identity (mode 0600).
 *      Used to sign requests to the bot so the bot can authenticate this install.
 *   2. Bot identity — public key baked in at build time (BOT_PUBKEY_HEX below).
 *      Every bot→desktop message carries an Ed25519 signature; the desktop
 *      refuses messages whose signature does not verify.
 *
 * Threat model: a friend's compromised Telegram account or a compromised bot
 * server cannot push a malicious password hash to the desktop without also
 * compromising the build pipeline (which would let them swap BOT_PUBKEY_HEX).
 *
 * Implementation: pure Node `crypto` — no native dependencies, no rebuild dance.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { KeyObject } from 'crypto';
import { getUserDataPath, ensureDir } from './storage.js';

/**
 * Ed25519 public key of the NightOwl bot (raw 32 bytes, hex).
 *
 * Generated once and embedded in every desktop build. The matching private key
 * lives in the bot's Cloudflare Worker secrets (BOT_ED25519_PRIVKEY).
 *
 * Rotating this key is a coordinated event: deploy bot with new key, ship a new
 * desktop release, eventually retire the old key from the bot. Out of scope for
 * v2.0.0; we'd add multi-pubkey support to verifyBotSignature when needed.
 */
export const BOT_PUBKEY_HEX = 'c67a4785231869d571763e2f9f0a9c8a0f8c7480ffbe70a56259a50e4b849431';

/**
 * Bot base URL.
 *
 * Defaults to the project's hosted Worker so packaged macOS / Windows builds
 * "just work" for end users out of the box. NIGHTOWL_BOT_URL overrides at
 * runtime so a self-hoster or a developer running `wrangler dev` can point
 * the same binary at their own Worker without rebuilding.
 *
 * Rotating this URL is a coordinated event — same shape as rotating the bot
 * pubkey above. If we ever cut over to a new hosted Worker, we'd ship a new
 * desktop release with the new URL, leave the old Worker up long enough for
 * existing installs to migrate, then retire it.
 */
export const BOT_URL: string =
  process.env.NIGHTOWL_BOT_URL || 'https://nightowl-bot.asmee-dh-work.workers.dev';

/** SPKI DER prefix for an Ed25519 public key (12 bytes), followed by the 32-byte raw key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Path on disk where this install's private key PEM is stored. */
export function getIdentityPath(): string {
  return path.join(getUserDataPath(), '.identity');
}

/** Generate a fresh Ed25519 keypair. Public key returned as raw-32-bytes hex; private key as PEM. */
export function generateIdentity(): { publicKeyHex: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const publicKeyHex = pubDer.subarray(-32).toString('hex');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { publicKeyHex, privateKeyPem };
}

/**
 * Load the install's identity from disk.
 * Returns null if no identity has been generated yet (first run, or wiped).
 */
export function loadIdentity(): { publicKeyHex: string; privateKey: KeyObject } | null {
  const identityPath = getIdentityPath();
  if (!fs.existsSync(identityPath)) return null;

  const pem = fs.readFileSync(identityPath, 'utf8');
  const privateKey = crypto.createPrivateKey({ key: pem, format: 'pem' });

  // Derive the public key from the private key so the caller doesn't need to store both.
  const publicKey = crypto.createPublicKey(privateKey);
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const publicKeyHex = pubDer.subarray(-32).toString('hex');

  return { publicKeyHex, privateKey };
}

/** Persist a private key PEM to disk with 0600 perms (no-op on Windows for the chmod). */
export function saveIdentity(privateKeyPem: string): void {
  const identityPath = getIdentityPath();
  ensureDir(path.dirname(identityPath));
  fs.writeFileSync(identityPath, privateKeyPem, { mode: 0o600 });
  // ensure the perms even if the file already existed
  try {
    fs.chmodSync(identityPath, 0o600);
  } catch {
    // chmod may not be supported on all filesystems; best-effort.
  }
}

/** Get-or-create the install identity. Returned object holds the live KeyObject. */
export function ensureIdentity(): { publicKeyHex: string; privateKey: KeyObject } {
  const existing = loadIdentity();
  if (existing) return existing;

  const { privateKeyPem } = generateIdentity();
  saveIdentity(privateKeyPem);
  const reloaded = loadIdentity();
  if (!reloaded) {
    throw new Error('ensureIdentity: failed to reload identity after writing it');
  }
  return reloaded;
}

/**
 * Sign a payload with the install's private key.
 * Ed25519 in Node requires `null` as the digest algorithm.
 * Returns base64-encoded signature.
 */
export function signPayload(privateKey: KeyObject, payload: string): string {
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey);
  return sig.toString('base64');
}

/**
 * Build a KeyObject from a raw 32-byte Ed25519 public key in hex.
 * Wraps the raw bytes in a minimal SPKI DER envelope, which Node's
 * createPublicKey accepts as `format: 'der', type: 'spki'`.
 */
function publicKeyFromRawHex(hex: string): KeyObject {
  if (hex.length !== 64) {
    throw new Error(`publicKeyFromRawHex: expected 64 hex chars, got ${hex.length}`);
  }
  const raw = Buffer.from(hex, 'hex');
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * Verify a bot signature over `canonical` payload. Returns true iff the signature
 * was produced by the holder of BOT_PUBKEY_HEX's matching private key.
 *
 * `pubkeyHex` defaults to BOT_PUBKEY_HEX; tests override.
 */
export function verifyBotSignature(canonical: string, sigB64: string, pubkeyHex: string = BOT_PUBKEY_HEX): boolean {
  try {
    const sig = Buffer.from(sigB64, 'base64');
    if (sig.length !== 64) return false;
    const pubKey = publicKeyFromRawHex(pubkeyHex);
    return crypto.verify(null, Buffer.from(canonical, 'utf8'), pubKey, sig);
  } catch {
    return false;
  }
}
