/**
 * POST /desktop/poll
 *
 * Desktop pulls any pending inbox messages with seq > lastSeq.
 * Body: { pairingId, lastSeq, ts, sig } where sig = Ed25519(priv, "poll|"+pairingId+"|"+lastSeq+"|"+ts)
 *
 * Each returned message carries the bot's signature; desktop verifies before any side effect.
 */

import type { Env } from '../env.js';
import type { PollRequest, PollResponse } from '../types.js';
import { verifyDesktopSignature } from '../crypto.js';
import { getInbox, getPairing, pendingMessages } from '../kv.js';
import { jsonResponse, badRequest, notFound } from '../response.js';

const SKEW_TOLERANCE_MS = 60_000;

export async function handlePoll(req: Request, env: Env): Promise<Response> {
  let body: PollRequest;
  try {
    body = (await req.json()) as PollRequest;
  } catch {
    return badRequest('invalid JSON');
  }

  if (typeof body.pairingId !== 'string' || !body.pairingId) return badRequest('pairingId required');
  if (typeof body.lastSeq !== 'number') return badRequest('lastSeq must be a number');
  if (typeof body.ts !== 'number') return badRequest('ts must be a number');
  if (typeof body.sig !== 'string') return badRequest('sig must be a string');

  if (Math.abs(Date.now() - body.ts) > SKEW_TOLERANCE_MS) {
    return badRequest('ts skew too large; check system clock');
  }

  const pairing = await getPairing(env, body.pairingId);
  if (!pairing) return notFound('pairing not found (or wiped)');

  const preimage = `poll|${body.pairingId}|${body.lastSeq}|${body.ts}`;
  const ok = await verifyDesktopSignature(pairing.userPubkeyHex, preimage, body.sig);
  if (!ok) return badRequest('signature does not verify');

  const inbox = await getInbox(env, body.pairingId);
  const pending = pendingMessages(inbox, body.lastSeq);

  const response: PollResponse = {
    messages: pending,
    botSeq: pairing.botSeq,
    friendName: pairing.friendName,
    status: pairing.status,
  };
  return jsonResponse(response);
}
