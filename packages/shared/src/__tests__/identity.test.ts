import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BOT_PUBKEY_HEX,
  generateIdentity,
  loadIdentity,
  saveIdentity,
  ensureIdentity,
  signPayload,
  verifyBotSignature,
  getIdentityPath,
} from '../identity.js';

function withTempDataDir<T>(fn: () => T): T {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-identity-'));
  const prev = process.env.NIGHTOWL_DATA_PATH;
  process.env.NIGHTOWL_DATA_PATH = tmp;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.NIGHTOWL_DATA_PATH;
    else process.env.NIGHTOWL_DATA_PATH = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('generateIdentity', () => {
  it('produces a 64-hex-char public key and a PEM-encoded private key', () => {
    const { publicKeyHex, privateKeyPem } = generateIdentity();
    expect(publicKeyHex).toHaveLength(64);
    expect(publicKeyHex).toMatch(/^[0-9a-f]+$/);
    expect(privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
  });

  it('produces a different keypair each call', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
    expect(a.privateKeyPem).not.toBe(b.privateKeyPem);
  });
});

describe('saveIdentity / loadIdentity', () => {
  it('round-trips a generated keypair through disk', () => {
    withTempDataDir(() => {
      const generated = generateIdentity();
      saveIdentity(generated.privateKeyPem);

      const loaded = loadIdentity();
      expect(loaded).not.toBeNull();
      expect(loaded!.publicKeyHex).toBe(generated.publicKeyHex);
    });
  });

  it('returns null when no identity file exists', () => {
    withTempDataDir(() => {
      expect(loadIdentity()).toBeNull();
    });
  });

  it('writes the identity file with mode 0600 on POSIX', () => {
    if (process.platform === 'win32') return;
    withTempDataDir(() => {
      const { privateKeyPem } = generateIdentity();
      saveIdentity(privateKeyPem);
      const stat = fs.statSync(getIdentityPath());
      // mask off file-type bits, keep just the perm bits
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });
});

describe('ensureIdentity', () => {
  it('creates an identity on first call and returns the same one on next call', () => {
    withTempDataDir(() => {
      const a = ensureIdentity();
      const b = ensureIdentity();
      expect(a.publicKeyHex).toBe(b.publicKeyHex);
    });
  });
});

describe('signPayload + verifyBotSignature', () => {
  it('round-trips: a signature made by a key verifies under that same key', () => {
    const { publicKeyHex, privateKeyPem } = generateIdentity();
    // Re-load the key to get a fresh KeyObject (mirrors the on-disk path).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightowl-sig-'));
    const prev = process.env.NIGHTOWL_DATA_PATH;
    process.env.NIGHTOWL_DATA_PATH = tmp;
    try {
      saveIdentity(privateKeyPem);
      const loaded = loadIdentity()!;
      const payload = 'v2|payload|123|kind|{"hash":"abc"}';
      const sig = signPayload(loaded.privateKey, payload);
      expect(verifyBotSignature(payload, sig, publicKeyHex)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NIGHTOWL_DATA_PATH;
      else process.env.NIGHTOWL_DATA_PATH = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a mutated payload', () => {
    withTempDataDir(() => {
      const { publicKeyHex, privateKeyPem } = generateIdentity();
      saveIdentity(privateKeyPem);
      const loaded = loadIdentity()!;
      const payload = 'hello';
      const sig = signPayload(loaded.privateKey, payload);
      expect(verifyBotSignature('hello!', sig, publicKeyHex)).toBe(false);
    });
  });

  it('rejects a mutated signature', () => {
    withTempDataDir(() => {
      const { publicKeyHex, privateKeyPem } = generateIdentity();
      saveIdentity(privateKeyPem);
      const loaded = loadIdentity()!;
      const sig = signPayload(loaded.privateKey, 'hello');
      const buf = Buffer.from(sig, 'base64');
      buf[0] = buf[0] ^ 0x01;
      expect(verifyBotSignature('hello', buf.toString('base64'), publicKeyHex)).toBe(false);
    });
  });

  it('rejects when verifying against a different public key', () => {
    withTempDataDir(() => {
      const a = generateIdentity();
      const b = generateIdentity();
      saveIdentity(a.privateKeyPem);
      const loadedA = loadIdentity()!;
      const sig = signPayload(loadedA.privateKey, 'hello');
      expect(verifyBotSignature('hello', sig, b.publicKeyHex)).toBe(false);
    });
  });

  it('rejects malformed base64 signatures without throwing', () => {
    expect(verifyBotSignature('hello', 'not-base64-!!!', BOT_PUBKEY_HEX)).toBe(false);
  });

  it('rejects signatures of the wrong length', () => {
    // 64 hex char pubkey is fine — we just want a too-short sig
    expect(verifyBotSignature('hello', Buffer.alloc(63).toString('base64'), BOT_PUBKEY_HEX)).toBe(false);
  });

  it('defaults to BOT_PUBKEY_HEX when no key argument is passed', () => {
    // We can't sign with the matching priv (we don't have it in tests), so we
    // just verify the default path runs without throwing for an obviously bad sig.
    expect(verifyBotSignature('hello', Buffer.alloc(64).toString('base64'))).toBe(false);
  });
});

describe('BOT_PUBKEY_HEX constant', () => {
  it('is a 64-char hex string', () => {
    expect(BOT_PUBKEY_HEX).toHaveLength(64);
    expect(BOT_PUBKEY_HEX).toMatch(/^[0-9a-f]+$/);
  });
});
