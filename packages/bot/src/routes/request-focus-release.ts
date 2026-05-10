/**
 * POST /desktop/request-focus-release
 *
 * Desktop asks the bot to DM the friend with /approve|/deny for early
 * termination of an active Friend Focus session. Mirror of
 * /desktop/request-uninstall but with a 'focus_release' kind so the bot
 * can route /approve to the right signed message kind.
 *
 * Idempotent on reqId — same as the uninstall flow.
 */

import type { Env } from '../env.js';
import type { RequestFocusReleaseBody, RequestFocusReleaseResponse, UninstallRequest } from '../types.js';
import { verifyDesktopSignature } from '../crypto.js';
import { getPairing, getUninstallRequest, putUninstallRequest } from '../kv.js';
import { jsonResponse, badRequest, notFound } from '../response.js';
import { notifyFriendOfFocusReleaseRequest } from './tg-webhook.js';

const SKEW_TOLERANCE_MS = 60_000;

export async function handleRequestFocusRelease(req: Request, env: Env): Promise<Response> {
  let body: RequestFocusReleaseBody;
  try {
    body = (await req.json()) as RequestFocusReleaseBody;
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
  if (typeof body.focusMinutes !== 'number' || body.focusMinutes < 1 || body.focusMinutes > 480) {
    return badRequest('focusMinutes must be between 1 and 480');
  }
  if (typeof body.focusStartedAt !== 'string') return badRequest('focusStartedAt must be ISO timestamp');

  if (Math.abs(Date.now() - body.ts) > SKEW_TOLERANCE_MS) {
    return badRequest('ts skew too large; check system clock');
  }

  const pairing = await getPairing(env, body.pairingId);
  if (!pairing) return notFound('pairing not found');

  const preimage = `request_focus_release|${body.pairingId}|${body.reqId}|${body.ts}`;
  const ok = await verifyDesktopSignature(pairing.userPubkeyHex, preimage, body.sig);
  if (!ok) return badRequest('signature does not verify');

  if (!pairing.friendChatId) {
    const resp: RequestFocusReleaseResponse = { reqId: body.reqId, result: 'no_friend' };
    return jsonResponse(resp);
  }

  const existing = await getUninstallRequest(env, body.reqId);
  if (existing) {
    const resp: RequestFocusReleaseResponse = { reqId: body.reqId, result: 'duplicate' };
    return jsonResponse(resp);
  }

  const ureq: UninstallRequest = {
    reqId: body.reqId,
    pairingId: body.pairingId,
    kind: 'focus_release',
    createdAt: body.createdAt,
    status: 'pending',
    decidedAt: null,
    promptMessageId: null,
  };
  await putUninstallRequest(env, ureq);

  const promptMessageId = await notifyFriendOfFocusReleaseRequest(env, pairing, ureq, {
    focusMinutes: body.focusMinutes,
    focusStartedAt: body.focusStartedAt,
  });
  if (promptMessageId != null) {
    ureq.promptMessageId = promptMessageId;
    await putUninstallRequest(env, ureq);
  }

  const resp: RequestFocusReleaseResponse = { reqId: body.reqId, result: 'queued' };
  return jsonResponse(resp);
}
