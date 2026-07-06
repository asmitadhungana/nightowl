/**
 * POST /desktop/enroll
 *
 * Desktop registers its install pubkey, gets back a pairing_id + 8-char pair_code.
 * Body: { userPubkeyHex, ts, sig } where sig = Ed25519(priv, "enroll|"+pubkey+"|"+ts)
 *
 * Clock-skew defense: ts must be within ±60s of bot's now. This means the bot
 * doesn't accept ancient enrollment requests, but the desktop must have a
 * roughly correct system clock — which is a v1 invariant already (curfew is
 * local-time-based).
 */

import type { Env } from '../env.js';
import type { EnrollRequest, EnrollResponse, Pairing } from '../types.js';
import { generatePairCode, generatePairingId, verifyDesktopSignature } from '../crypto.js';
import { PAIR_CODE_TTL_MS, putPairCode, putPairing } from '../kv.js';
import { jsonResponse, badRequest } from '../response.js';

const SKEW_TOLERANCE_MS = 60_000;

export async function handleEnroll(req: Request, env: Env): Promise<Response> {
  let body: EnrollRequest;
  try {
    body = (await req.json()) as EnrollRequest;
  } catch {
    return badRequest('invalid JSON');
  }

  if (!body.userPubkeyHex || typeof body.userPubkeyHex !== 'string' || !/^[0-9a-f]{64}$/.test(body.userPubkeyHex)) {
    return badRequest('userPubkeyHex must be 64 lowercase hex chars');
  }
  if (typeof body.ts !== 'number') return badRequest('ts must be a number');
  if (typeof body.sig !== 'string') return badRequest('sig must be a string');

  if (Math.abs(Date.now() - body.ts) > SKEW_TOLERANCE_MS) {
    return badRequest('ts skew too large; check system clock');
  }

  const preimage = `enroll|${body.userPubkeyHex}|${body.ts}`;
  const ok = await verifyDesktopSignature(body.userPubkeyHex, preimage, body.sig);
  if (!ok) return badRequest('signature does not verify');

  const pairingId = generatePairingId();
  const pairCode = generatePairCode();
  const expiresAt = Date.now() + PAIR_CODE_TTL_MS;

  const pairing: Pairing = {
    pairingId,
    userPubkeyHex: body.userPubkeyHex,
    friendChatId: null,
    friendName: null,
    createdAt: new Date().toISOString(),
    status: 'pending',
    botSeq: 0,
    passwordConsumed: false,
  };

  await putPairing(env, pairing);
  await putPairCode(env, pairCode, pairingId, expiresAt);

  const response: EnrollResponse = { pairingId, pairCode, expiresAt };
  return jsonResponse(response);
}
