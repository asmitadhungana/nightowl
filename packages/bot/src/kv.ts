/**
 * KV access layer. All keys namespaced; values are JSON.
 *
 * Keys:
 *   pair:<pairingId>     Pairing — primary record
 *   pcode:<code>         { pairingId } — KV TTL = 5 min
 *   inbox:<pairingId>    InboxMessage[] — capped, FIFO
 */

import type { Env } from './env.js';
import type { InboxMessage, PairCodeRecord, Pairing } from './types.js';

const PAIR_PREFIX = 'pair:';
const PCODE_PREFIX = 'pcode:';
const INBOX_PREFIX = 'inbox:';

const PAIR_CODE_TTL_SECONDS = 5 * 60;
const INBOX_CAP = 50;

export async function getPairing(env: Env, pairingId: string): Promise<Pairing | null> {
  const raw = await env.NIGHTOWL_KV.get(PAIR_PREFIX + pairingId);
  return raw ? (JSON.parse(raw) as Pairing) : null;
}

export async function putPairing(env: Env, pairing: Pairing): Promise<void> {
  await env.NIGHTOWL_KV.put(PAIR_PREFIX + pairing.pairingId, JSON.stringify(pairing));
}

export async function getPairCode(env: Env, code: string): Promise<PairCodeRecord | null> {
  const raw = await env.NIGHTOWL_KV.get(PCODE_PREFIX + code);
  if (!raw) return null;
  const rec = JSON.parse(raw) as PairCodeRecord;
  // Double-check expiry; KV TTL is best-effort.
  if (rec.expiresAt < Date.now()) return null;
  return rec;
}

export async function putPairCode(env: Env, code: string, pairingId: string, expiresAtMs: number): Promise<void> {
  const value: PairCodeRecord = { pairingId, expiresAt: expiresAtMs };
  await env.NIGHTOWL_KV.put(PCODE_PREFIX + code, JSON.stringify(value), {
    expirationTtl: PAIR_CODE_TTL_SECONDS,
  });
}

export async function deletePairCode(env: Env, code: string): Promise<void> {
  await env.NIGHTOWL_KV.delete(PCODE_PREFIX + code);
}

export async function getInbox(env: Env, pairingId: string): Promise<InboxMessage[]> {
  const raw = await env.NIGHTOWL_KV.get(INBOX_PREFIX + pairingId);
  return raw ? (JSON.parse(raw) as InboxMessage[]) : [];
}

export async function appendInbox(env: Env, pairingId: string, msg: InboxMessage): Promise<void> {
  const current = await getInbox(env, pairingId);
  current.push(msg);
  // Cap from the front. Loss of un-consumed old messages is acceptable — the
  // desktop polls aggressively during `awaiting_password`, and an inbox of >50
  // backlogged messages is symptomatic of a stuck client we won't recover.
  while (current.length > INBOX_CAP) current.shift();
  await env.NIGHTOWL_KV.put(INBOX_PREFIX + pairingId, JSON.stringify(current));
}

/** Filter inbox to messages with seq > lastSeq, in seq order. */
export function pendingMessages(inbox: InboxMessage[], lastSeq: number): InboxMessage[] {
  return inbox.filter((m) => m.seq > lastSeq).sort((a, b) => a.seq - b.seq);
}

export const PAIR_CODE_TTL_MS = PAIR_CODE_TTL_SECONDS * 1000;
