/**
 * POST /desktop/request-uninstall
 *
 * Desktop asks the bot to DM the friend with an /approve|/deny prompt.
 *
 * Body: { pairingId, reqId, createdAt, ts, sig } where
 *   sig = Ed25519(priv, "request_uninstall|"+pairingId+"|"+reqId+"|"+ts)
 *
 * Idempotent: posting the same reqId twice returns { result: 'duplicate' } without
 * re-DMing the friend. This matters because the desktop retries on flaky network
 * and we don't want to spam the friend.
 */

import type { Env } from '../env.js';
import type { RequestUninstallBody, RequestUninstallResponse, UninstallRequest } from '../types.js';
import { verifyDesktopSignature } from '../crypto.js';
import { getPairing, getUninstallRequest, putUninstallRequest } from '../kv.js';
import { jsonResponse, badRequest, notFound } from '../response.js';
import { notifyFriendOfUninstallRequest } from './tg-webhook.js';

const SKEW_TOLERANCE_MS = 60_000;

export async function handleRequestUninstall(req: Request, env: Env): Promise<Response> {
  let body: RequestUninstallBody;
  try {
    body = (await req.json()) as RequestUninstallBody;
  } catch {
    return badRequest('invalid JSON');
  }

  if (typeof body.pairingId !== 'string' || !body.pairingId) return badRequest('pairingId required');
  if (typeof body.reqId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.reqId)) {
    return badRequest('reqId must be a UUIDv4');
  }
  if (typeof body.ts !== 'number') return badRequest('ts must be a number');
  if (typeof body.sig !== 'string') return badRequest('sig must be a string');
  if (typeof body.createdAt !== 'string') return badRequest('createdAt must be ISO timestamp');

  if (Math.abs(Date.now() - body.ts) > SKEW_TOLERANCE_MS) {
    return badRequest('ts skew too large; check system clock');
  }

  const pairing = await getPairing(env, body.pairingId);
  if (!pairing) return notFound('pairing not found');

  const preimage = `request_uninstall|${body.pairingId}|${body.reqId}|${body.ts}`;
  const ok = await verifyDesktopSignature(pairing.userPubkeyHex, preimage, body.sig);
  if (!ok) return badRequest('signature does not verify');

  // Friend hasn't paired yet — nothing to ask.
  if (!pairing.friendChatId) {
    const resp: RequestUninstallResponse = { reqId: body.reqId, result: 'no_friend' };
    return jsonResponse(resp);
  }

  // Idempotent: same reqId already in flight or decided → don't re-DM.
  const existing = await getUninstallRequest(env, body.reqId);
  if (existing) {
    const resp: RequestUninstallResponse = { reqId: body.reqId, result: 'duplicate' };
    return jsonResponse(resp);
  }

  const ureq: UninstallRequest = {
    reqId: body.reqId,
    pairingId: body.pairingId,
    kind: 'uninstall',
    createdAt: body.createdAt,
    status: 'pending',
    decidedAt: null,
    promptMessageId: null,
  };
  await putUninstallRequest(env, ureq);

  // DM the friend. Best-effort — if Telegram is down the desktop can re-request
  // (idempotency keys this off reqId so the user must mint a fresh one to retry).
  const promptMessageId = await notifyFriendOfUninstallRequest(env, pairing, ureq);
  if (promptMessageId != null) {
    ureq.promptMessageId = promptMessageId;
    await putUninstallRequest(env, ureq);
  }

  const resp: RequestUninstallResponse = { reqId: body.reqId, result: 'queued' };
  return jsonResponse(resp);
}
