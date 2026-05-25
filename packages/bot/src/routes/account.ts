/**
 * Circles Phase 1 — multi-device Account endpoints.
 *
 *   POST /desktop/account/create     founding device starts an account
 *   POST /desktop/account/join-code  an existing device mints a short-lived join code
 *   POST /desktop/account/attach     a new device redeems a code to join the account
 *   POST /desktop/account/heartbeat  a device reports whether it is enforcing now
 *
 * Every request is Ed25519-signed by the device's own key (the same key shape the
 * bot already verifies for enroll/poll). A device-join code is "confirmation by an
 * existing device" (design R3): only an already-attached device can mint one, and
 * it expires in 5 minutes, so a leaked code alone can't add a device for long.
 *
 * Account *logic* (dup/cap rules) mirrors @nightowl/shared `account.ts`, which is
 * unit-tested; it is re-implemented here to keep the Worker bundle free of node
 * built-ins (same "duplicate the wire, don't couple the code" rule as the Kotlin
 * mirror). NOT YET DEPLOYED — typecheck-verified; deploy after review.
 */

import type { Env } from '../env.js';
import type {
  Account,
  AttachDeviceBody,
  AttachDeviceResponse,
  CreateAccountBody,
  CreateAccountResponse,
  HeartbeatBody,
  MintJoinCodeBody,
  MintJoinCodeResponse,
} from '../types.js';
import { MAX_DEVICES_PER_ACCOUNT } from '../types.js';
import { generatePairCode, generatePairingId, verifyDesktopSignature } from '../crypto.js';
import {
  deleteJoinCode,
  getAccount,
  getJoinCode,
  JOIN_CODE_TTL_MS,
  putAccount,
  putJoinCode,
} from '../kv.js';
import { badRequest, emptyOk, jsonResponse, notFound } from '../response.js';

const SKEW_TOLERANCE_MS = 60_000;
const HEX64 = /^[0-9a-f]{64}$/;

function skewOk(ts: number): boolean {
  return typeof ts === 'number' && Math.abs(Date.now() - ts) <= SKEW_TOLERANCE_MS;
}

/** POST /desktop/account/create */
export async function handleCreateAccount(req: Request, env: Env): Promise<Response> {
  let body: CreateAccountBody;
  try {
    body = (await req.json()) as CreateAccountBody;
  } catch {
    return badRequest('invalid JSON');
  }
  if (!HEX64.test(body.devicePubkeyHex ?? '')) return badRequest('devicePubkeyHex must be 64 lowercase hex chars');
  if (typeof body.label !== 'string' || body.label.length === 0 || body.label.length > 64) {
    return badRequest('label must be 1–64 chars');
  }
  if (!skewOk(body.ts)) return badRequest('ts skew too large; check system clock');
  if (typeof body.sig !== 'string') return badRequest('sig must be a string');

  const preimage = `account_create|${body.devicePubkeyHex}|${body.ts}`;
  if (!(await verifyDesktopSignature(body.devicePubkeyHex, preimage, body.sig))) {
    return badRequest('signature does not verify');
  }

  const accountId = generatePairingId();
  const now = new Date().toISOString();
  const account: Account = {
    accountId,
    createdAt: now,
    devices: [{ devicePubkeyHex: body.devicePubkeyHex, label: body.label, attachedAt: now, lastHeartbeatAt: null, lastEnforcing: false }],
  };
  await putAccount(env, account);
  const response: CreateAccountResponse = { accountId };
  return jsonResponse(response);
}

/** POST /desktop/account/join-code */
export async function handleMintJoinCode(req: Request, env: Env): Promise<Response> {
  let body: MintJoinCodeBody;
  try {
    body = (await req.json()) as MintJoinCodeBody;
  } catch {
    return badRequest('invalid JSON');
  }
  if (typeof body.accountId !== 'string' || !body.accountId) return badRequest('accountId required');
  if (!HEX64.test(body.devicePubkeyHex ?? '')) return badRequest('devicePubkeyHex must be 64 lowercase hex chars');
  if (!skewOk(body.ts)) return badRequest('ts skew too large; check system clock');
  if (typeof body.sig !== 'string') return badRequest('sig must be a string');

  const account = await getAccount(env, body.accountId);
  if (!account) return notFound('account not found');

  // Minter must already be in the account (existing-device confirmation, R3).
  const minter = account.devices.find((d) => d.devicePubkeyHex === body.devicePubkeyHex);
  if (!minter) return badRequest('minting device is not attached to this account');

  const preimage = `account_joincode|${body.accountId}|${body.devicePubkeyHex}|${body.ts}`;
  if (!(await verifyDesktopSignature(body.devicePubkeyHex, preimage, body.sig))) {
    return badRequest('signature does not verify');
  }

  const code = generatePairCode();
  const expiresAt = Date.now() + JOIN_CODE_TTL_MS;
  await putJoinCode(env, code, body.accountId, expiresAt);
  const response: MintJoinCodeResponse = { code, expiresAt };
  return jsonResponse(response);
}

/** POST /desktop/account/attach */
export async function handleAttachDevice(req: Request, env: Env): Promise<Response> {
  let body: AttachDeviceBody;
  try {
    body = (await req.json()) as AttachDeviceBody;
  } catch {
    return badRequest('invalid JSON');
  }
  if (typeof body.code !== 'string' || !body.code) return badRequest('code required');
  if (!HEX64.test(body.devicePubkeyHex ?? '')) return badRequest('devicePubkeyHex must be 64 lowercase hex chars');
  if (typeof body.label !== 'string' || body.label.length === 0 || body.label.length > 64) {
    return badRequest('label must be 1–64 chars');
  }
  if (!skewOk(body.ts)) return badRequest('ts skew too large; check system clock');
  if (typeof body.sig !== 'string') return badRequest('sig must be a string');

  // The NEW device signs, proving it owns the key it's registering.
  const preimage = `account_attach|${body.code}|${body.devicePubkeyHex}|${body.ts}`;
  if (!(await verifyDesktopSignature(body.devicePubkeyHex, preimage, body.sig))) {
    return badRequest('signature does not verify');
  }

  const codeRec = await getJoinCode(env, body.code);
  if (!codeRec) return badRequest('join code invalid or expired');
  const account = await getAccount(env, codeRec.accountId);
  if (!account) return notFound('account not found');

  // Idempotent: re-attaching an existing device is a no-op success.
  if (account.devices.some((d) => d.devicePubkeyHex === body.devicePubkeyHex)) {
    const resp: AttachDeviceResponse = { accountId: account.accountId, result: 'already_attached' };
    return jsonResponse(resp);
  }
  if (account.devices.length >= MAX_DEVICES_PER_ACCOUNT) {
    return badRequest(`account already at the ${MAX_DEVICES_PER_ACCOUNT}-device limit`);
  }

  account.devices.push({
    devicePubkeyHex: body.devicePubkeyHex,
    label: body.label,
    attachedAt: new Date().toISOString(),
    lastHeartbeatAt: null,
    lastEnforcing: false,
  });
  await putAccount(env, account);
  // One-time code: burn it so it can't be replayed.
  await deleteJoinCode(env, body.code);

  const resp: AttachDeviceResponse = { accountId: account.accountId, result: 'attached' };
  return jsonResponse(resp);
}

/** POST /desktop/account/heartbeat */
export async function handleHeartbeat(req: Request, env: Env): Promise<Response> {
  let body: HeartbeatBody;
  try {
    body = (await req.json()) as HeartbeatBody;
  } catch {
    return badRequest('invalid JSON');
  }
  if (typeof body.accountId !== 'string' || !body.accountId) return badRequest('accountId required');
  if (!HEX64.test(body.devicePubkeyHex ?? '')) return badRequest('devicePubkeyHex must be 64 lowercase hex chars');
  if (typeof body.enforcing !== 'boolean') return badRequest('enforcing must be a boolean');
  if (!skewOk(body.ts)) return badRequest('ts skew too large; check system clock');
  if (typeof body.sig !== 'string') return badRequest('sig must be a string');

  const account = await getAccount(env, body.accountId);
  if (!account) return notFound('account not found');
  const device = account.devices.find((d) => d.devicePubkeyHex === body.devicePubkeyHex);
  if (!device) return badRequest('heartbeat from a device not attached to this account');

  const preimage = `account_heartbeat|${body.accountId}|${body.devicePubkeyHex}|${body.enforcing}|${body.ts}`;
  if (!(await verifyDesktopSignature(body.devicePubkeyHex, preimage, body.sig))) {
    return badRequest('signature does not verify');
  }

  device.lastHeartbeatAt = new Date().toISOString();
  device.lastEnforcing = body.enforcing;
  await putAccount(env, account);
  return emptyOk();
}
