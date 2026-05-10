/**
 * NightOwl Desktop — Friend Lock orchestrator (v2 alpha)
 *
 * Talks to the bot Worker over HTTPS. Owns the enroll → pair → password-hash
 * lifecycle and writes its results into the active schedule.
 *
 * Runs in the Electron main process (file system + IPC + crypto). The renderer
 * never touches network/keys.
 *
 * Polling cadence:
 *   - 60s when phase ∈ {active, revoked} (just keeping connection warm)
 *   - 10s when phase ∈ {enrolled, paired, awaiting_password} (user is staring
 *     at the screen; latency matters)
 *   - Exponential backoff on network errors: 30 → 60 → 120 → cap 300s
 *
 * Lifecycle:
 *   - Started in main/index.ts whenReady().
 *   - Stopped on app before-quit.
 *   - The poll loop is a setTimeout chain (not setInterval) so a slow request
 *     can't queue up behind itself.
 */

import crypto from 'crypto';
import { BrowserWindow } from 'electron';
import {
  loadSchedule,
  saveSchedule,
  savePasswordHash,
  activateSchedule,
  isLocked,
  ensureIdentity,
  signPayload,
  verifyBotSignature,
  BOT_URL,
  isDelegated,
  makeDelegation,
  uninstallGate,
  emergencyCooldownRemainingMs,
  canStartEmergencyUninstall,
  type DelegationState,
  type DelegationPhase,
  type UninstallGate,
} from '@nightowl/shared';

interface EnrollResponseBody {
  pairingId: string;
  pairCode: string;
  expiresAt: number;
}

interface PollMessage {
  seq: number;
  kind: 'pair_complete' | 'password_hash' | 'friend_revoked' | 'uninstall_decision';
  payload: unknown;
  sig: string;
}

interface PollResponseBody {
  messages: PollMessage[];
  botSeq: number;
  friendName: string | null;
  status: 'pending' | 'active' | 'revoked';
}

interface PairCompletePayload {
  friendName: string;
  friendChatId: string;
}

interface PasswordHashPayload {
  hash: string;
  passwordSetAt: string;
}

interface FriendRevokedPayload {
  revokedAt: string;
}

interface UninstallDecisionPayload {
  reqId: string;
  verdict: 'approved' | 'denied';
  decidedAt: string;
}

/**
 * Tracks the most recent uninstall decision per delegation. Persisted to the
 * delegation as an ad-hoc field so a restart doesn't lose the verdict the user
 * was about to act on. Stored separately from `pendingUninstallReqId` because
 * we want history (approved-then-user-canceled) without losing the prior state.
 */
export interface UninstallDecisionRecord {
  reqId: string;
  verdict: 'approved' | 'denied';
  decidedAt: string;
}

const POLL_FAST_MS = 10_000;
const POLL_SLOW_MS = 60_000;
const BACKOFF_START_MS = 30_000;
const BACKOFF_MAX_MS = 300_000;

const REQUEST_TIMEOUT_MS = 15_000;

/** Mutable state held in this module. */
interface State {
  pollTimer: NodeJS.Timeout | null;
  currentBackoffMs: number;
  /** Wallclock timestamp of the last bot-unreachable signal we surfaced to UI. */
  lastUnreachableAt: number | null;
}

const state: State = {
  pollTimer: null,
  currentBackoffMs: BACKOFF_START_MS,
  lastUnreachableAt: null,
};

/** Public summary of delegation state for the UI. */
export interface DelegationStatus {
  delegated: boolean;
  phase: DelegationPhase | null;
  pairingId: string | null;
  friendName: string | null;
  pairCode: string | null;
  pairCodeExpiresAt: number | null;
}

/** In-memory: the active pair code (not persisted; if the app restarts mid-enroll, user re-pairs). */
let lastPairCode: string | null = null;
let lastPairCodeExpiresAt: number | null = null;

export function getDelegationStatus(): DelegationStatus {
  const s = loadSchedule();
  if (!isDelegated(s) || !s.delegation) {
    return {
      delegated: false,
      phase: null,
      pairingId: null,
      friendName: null,
      pairCode: lastPairCode,
      pairCodeExpiresAt: lastPairCodeExpiresAt,
    };
  }
  const d = s.delegation;
  return {
    delegated: true,
    phase: d.phase,
    pairingId: d.pairingId,
    friendName: d.friendName,
    pairCode: lastPairCode,
    pairCodeExpiresAt: lastPairCodeExpiresAt,
  };
}

/**
 * Enroll: register this install's pubkey with the bot and get a pair code.
 * Stamps a fresh DelegationState onto the schedule with phase='enrolled'.
 *
 * Idempotency: if there's already a delegation in phase ∈ {paired, awaiting_password,
 * active}, we refuse — the user must cancel first to avoid clobbering an in-flight pairing.
 */
export async function enroll(): Promise<{ ok: boolean; pairingId?: string; pairCode?: string; expiresAt?: number; error?: string }> {
  const schedule = loadSchedule();
  if (schedule.delegation && schedule.delegation.phase !== 'enrolled' && schedule.delegation.phase !== 'revoked') {
    return { ok: false, error: `Already ${schedule.delegation.phase}; cancel first` };
  }
  if (!schedule.lockPeriodDays) {
    return { ok: false, error: 'Save a schedule with a lock duration first' };
  }

  const identity = ensureIdentity();
  const ts = Date.now();
  const preimage = `enroll|${identity.publicKeyHex}|${ts}`;
  const sig = signPayload(identity.privateKey, preimage);

  let body: EnrollResponseBody;
  try {
    const r = await fetchJson(`${BOT_URL}/desktop/enroll`, { userPubkeyHex: identity.publicKeyHex, ts, sig });
    body = r as EnrollResponseBody;
  } catch (e) {
    return { ok: false, error: `Bot unreachable: ${(e as Error).message}` };
  }

  // Persist a fresh delegation state. We do NOT activate the schedule yet —
  // active=false stays put until the password hash arrives.
  schedule.delegation = makeDelegation(body.pairingId);
  saveSchedule(schedule);

  lastPairCode = body.pairCode;
  lastPairCodeExpiresAt = body.expiresAt;

  // Bump polling immediately so we catch the friend's /pair as soon as possible.
  schedulePollSoon();
  emitPhaseChanged('enrolled');

  return { ok: true, pairingId: body.pairingId, pairCode: body.pairCode, expiresAt: body.expiresAt };
}

/** Cancel an in-flight pairing (only allowed before phase = 'active'). */
export async function cancelEnrollment(): Promise<{ ok: boolean; error?: string }> {
  const schedule = loadSchedule();
  if (!schedule.delegation) return { ok: true };
  if (schedule.delegation.phase === 'active') {
    return { ok: false, error: 'Lock is already active; cannot cancel pairing' };
  }
  schedule.delegation = null;
  saveSchedule(schedule);
  lastPairCode = null;
  lastPairCodeExpiresAt = null;
  emitPhaseChanged(null);
  return { ok: true };
}

/** Start the polling loop. Idempotent. */
export function startFriendlockPolling(): void {
  if (state.pollTimer) return;
  schedulePollSoon();
}

/** Stop the polling loop. Safe to call repeatedly. */
export function stopFriendlockPolling(): void {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

/** Internal: schedule the next poll based on phase. */
function schedulePollSoon(delayMs?: number): void {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  const interval = delayMs ?? pickPollInterval();
  state.pollTimer = setTimeout(() => {
    void pollOnce();
  }, interval);
}

function pickPollInterval(): number {
  const s = loadSchedule();
  if (!s.delegation) return POLL_SLOW_MS;
  switch (s.delegation.phase) {
    case 'enrolled':
    case 'paired':
    case 'awaiting_password':
      return POLL_FAST_MS;
    case 'active':
    case 'revoked':
      return POLL_SLOW_MS;
    default:
      return POLL_SLOW_MS;
  }
}

/** One iteration of the poll loop. */
async function pollOnce(): Promise<void> {
  const schedule = loadSchedule();
  if (!schedule.delegation) {
    // Nothing to poll for. Check back in a slow tick.
    schedulePollSoon(POLL_SLOW_MS);
    return;
  }

  const identity = ensureIdentity();
  const ts = Date.now();
  const preimage = `poll|${schedule.delegation.pairingId}|${schedule.delegation.lastConsumedSeq}|${ts}`;
  const sig = signPayload(identity.privateKey, preimage);

  let body: PollResponseBody;
  try {
    const r = await fetchJson(`${BOT_URL}/desktop/poll`, {
      pairingId: schedule.delegation.pairingId,
      lastSeq: schedule.delegation.lastConsumedSeq,
      ts,
      sig,
    });
    body = r as PollResponseBody;
    state.currentBackoffMs = BACKOFF_START_MS;
    state.lastUnreachableAt = null;
  } catch (e) {
    handlePollError(e as Error);
    return;
  }

  if (!Array.isArray(body.messages)) {
    schedulePollSoon();
    return;
  }

  // Process messages in seq order. Re-load schedule between messages because
  // dispatchers persist changes.
  const sortedMsgs = [...body.messages].sort((a, b) => a.seq - b.seq);
  for (const msg of sortedMsgs) {
    await handleInboxMessage(msg);
  }

  schedulePollSoon();
}

function handlePollError(err: Error): void {
  const now = Date.now();
  if (state.lastUnreachableAt == null) {
    state.lastUnreachableAt = now;
    emitBotUnreachable(now);
  }
  // Exponential backoff with cap.
  state.currentBackoffMs = Math.min(state.currentBackoffMs * 2, BACKOFF_MAX_MS);
  console.warn('[friendlock] poll failed', err.message, '— retrying in', state.currentBackoffMs, 'ms');
  schedulePollSoon(state.currentBackoffMs);
}

/**
 * Verify-then-dispatch one inbox message. Mutations to schedule.delegation are
 * persisted immediately so a crash mid-loop doesn't reprocess the same message.
 *
 * Replay defense: only messages with seq > delegation.lastConsumedSeq are
 * accepted. lastConsumedSeq is bumped after each successful dispatch.
 */
async function handleInboxMessage(msg: PollMessage): Promise<void> {
  const schedule = loadSchedule();
  if (!schedule.delegation) {
    console.warn('[friendlock] inbox message arrived but no delegation; dropping');
    return;
  }
  if (msg.seq <= schedule.delegation.lastConsumedSeq) {
    console.warn('[friendlock] dropping replayed/old seq', msg.seq, '<=', schedule.delegation.lastConsumedSeq);
    return;
  }

  // Verify the bot's signature over the canonical preimage. This is the
  // load-bearing check — refuse to act on unsigned/badly-signed messages.
  const preimage = botMessagePreimage(schedule.delegation.pairingId, msg.seq, msg.kind, msg.payload);
  if (!verifyBotSignature(preimage, msg.sig)) {
    console.warn('[friendlock] dropping message with bad signature, kind=', msg.kind, 'seq=', msg.seq);
    return;
  }

  switch (msg.kind) {
    case 'pair_complete':
      await dispatchPairComplete(schedule.delegation, msg.payload as PairCompletePayload, msg.seq);
      break;
    case 'password_hash':
      await dispatchPasswordHash(schedule.delegation, msg.payload as PasswordHashPayload, msg.seq);
      break;
    case 'friend_revoked':
      await dispatchFriendRevoked(schedule.delegation, msg.payload as FriendRevokedPayload, msg.seq);
      break;
    case 'uninstall_decision':
      await dispatchUninstallDecision(schedule.delegation, msg.payload as UninstallDecisionPayload, msg.seq);
      break;
    default:
      console.warn('[friendlock] unknown message kind, dropping');
      // Bump consumed seq anyway so we don't refetch it forever.
      bumpConsumedSeq(msg.seq);
  }
}

async function dispatchPairComplete(
  delegation: DelegationState,
  payload: PairCompletePayload,
  seq: number
): Promise<void> {
  const schedule = loadSchedule();
  if (!schedule.delegation) return;

  schedule.delegation.friendName = payload.friendName ?? null;
  schedule.delegation.friendChatId = payload.friendChatId ?? null;
  schedule.delegation.pairedAt = new Date().toISOString();
  schedule.delegation.phase = 'awaiting_password';
  schedule.delegation.lastConsumedSeq = seq;
  saveSchedule(schedule);

  emitPhaseChanged('awaiting_password');
  emitFriendPaired(payload.friendName);
  // Suppress unused-import warning so the stricter compiler doesn't gripe.
  void delegation;
}

async function dispatchPasswordHash(
  delegation: DelegationState,
  payload: PasswordHashPayload,
  seq: number
): Promise<void> {
  const schedule = loadSchedule();
  if (!schedule.delegation) return;

  if (!payload.hash || typeof payload.hash !== 'string') {
    console.warn('[friendlock] password_hash missing hash field; dropping');
    bumpConsumedSeq(seq);
    return;
  }
  if (!schedule.lockPeriodDays) {
    console.warn('[friendlock] password_hash arrived but no lockPeriodDays set; dropping');
    bumpConsumedSeq(seq);
    return;
  }
  if (isLocked(schedule)) {
    console.warn('[friendlock] password_hash arrived but already locked; dropping');
    bumpConsumedSeq(seq);
    return;
  }

  // Persist the friend's hash, then activate the schedule. This is the moment
  // the user becomes locked out — we go from awaiting_password → active.
  savePasswordHash(payload.hash);

  const activated = activateSchedule(schedule, schedule.lockPeriodDays);
  // activateSchedule returned a fresh object; copy delegation forward.
  activated.delegation = {
    ...schedule.delegation,
    phase: 'active' as const,
    lastConsumedSeq: seq,
  };
  saveSchedule(activated);

  emitPhaseChanged('active');
  // Drop the in-memory pair code now — pairing is sealed.
  lastPairCode = null;
  lastPairCodeExpiresAt = null;

  void delegation;
}

async function dispatchFriendRevoked(
  delegation: DelegationState,
  payload: FriendRevokedPayload,
  seq: number
): Promise<void> {
  const schedule = loadSchedule();
  if (!schedule.delegation) return;
  // Move into the 'revoked' phase. Lock continues to lockEndDate; the UI will
  // surface the 72h emergency cooldown more prominently.
  schedule.delegation.phase = 'revoked';
  schedule.delegation.friendRevokedAt = payload.revokedAt ?? new Date().toISOString();
  schedule.delegation.lastConsumedSeq = seq;
  saveSchedule(schedule);
  emitPhaseChanged('revoked');
  void delegation;
}

async function dispatchUninstallDecision(
  delegation: DelegationState,
  payload: UninstallDecisionPayload,
  seq: number
): Promise<void> {
  const schedule = loadSchedule();
  if (!schedule.delegation) return;

  if (!payload.reqId || (payload.verdict !== 'approved' && payload.verdict !== 'denied')) {
    console.warn('[friendlock] uninstall_decision malformed; dropping');
    bumpConsumedSeq(seq);
    return;
  }
  if (schedule.delegation.pendingUninstallReqId !== payload.reqId) {
    // Out-of-band decision (e.g. user already cancelled, or this is from an old
    // request we no longer care about). Still record it — auditability — but
    // don't promote to "current."
    console.warn('[friendlock] uninstall_decision for a non-pending reqId; recording but not acting');
    schedule.delegation.lastConsumedSeq = seq;
    saveSchedule(schedule);
    bumpConsumedSeq(seq);
    return;
  }

  schedule.delegation.lastUninstallDecision = {
    reqId: payload.reqId,
    verdict: payload.verdict,
    decidedAt: payload.decidedAt ?? new Date().toISOString(),
  };
  schedule.delegation.pendingUninstallReqId = null;
  schedule.delegation.lastConsumedSeq = seq;
  saveSchedule(schedule);

  emitUninstallDecision(payload.verdict, payload.reqId);
  void delegation;
}

function bumpConsumedSeq(seq: number): void {
  const schedule = loadSchedule();
  if (!schedule.delegation) return;
  if (seq <= schedule.delegation.lastConsumedSeq) return;
  schedule.delegation.lastConsumedSeq = seq;
  saveSchedule(schedule);
}

// ---------------------------------------------------------------------------
// Uninstall request flow
//
// Desktop-initiated: user clicks "Ask {friend} to release" → mint reqId →
// POST /desktop/request-uninstall → bot DMs the friend with /approve|/deny.
// Decision arrives back as a signed `uninstall_decision` inbox message.
// ---------------------------------------------------------------------------

export interface RequestUninstallResult {
  ok: boolean;
  reqId?: string;
  /** Mirror of the bot's response: 'queued' | 'no_friend' | 'duplicate'. */
  result?: 'queued' | 'no_friend' | 'duplicate';
  error?: string;
}

export async function requestUninstall(): Promise<RequestUninstallResult> {
  const schedule = loadSchedule();
  if (!schedule.delegation) return { ok: false, error: 'No friend lock active' };
  if (schedule.delegation.phase !== 'active' && schedule.delegation.phase !== 'revoked') {
    return { ok: false, error: 'Lock is not active yet — cancel pairing instead of asking the friend' };
  }
  if (schedule.delegation.pendingUninstallReqId) {
    return { ok: false, error: 'A request is already pending. Wait for the friend to /approve or /deny.' };
  }
  if (schedule.delegation.phase === 'revoked') {
    return { ok: false, error: 'Friend has revoked their role — they will not respond. Use the 72h emergency cooldown.' };
  }

  const reqId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const identity = ensureIdentity();
  const ts = Date.now();
  const preimage = `request_uninstall|${schedule.delegation.pairingId}|${reqId}|${ts}`;
  const sig = signPayload(identity.privateKey, preimage);

  let body: { reqId: string; result: 'queued' | 'no_friend' | 'duplicate' };
  try {
    const r = await fetchJson(`${BOT_URL}/desktop/request-uninstall`, {
      pairingId: schedule.delegation.pairingId,
      reqId,
      createdAt,
      ts,
      sig,
    });
    body = r as { reqId: string; result: 'queued' | 'no_friend' | 'duplicate' };
  } catch (e) {
    return { ok: false, error: `Bot unreachable: ${(e as Error).message}` };
  }

  if (body.result === 'queued' || body.result === 'duplicate') {
    schedule.delegation.pendingUninstallReqId = reqId;
    saveSchedule(schedule);
    // Tighten polling to fast cadence so we catch the decision asap.
    schedulePollSoon();
  }

  return { ok: true, reqId, result: body.result };
}

/**
 * Cancel an in-flight uninstall request locally — purely a "I changed my mind,
 * stop showing 'request pending'" action. The bot's queued message and any
 * future friend decision still flow normally; if the friend /approves the
 * cancelled reqId, dispatchUninstallDecision sees the reqId no longer matches
 * pendingUninstallReqId and records the seq without promoting the verdict
 * (the existing "out-of-band decision" branch).
 *
 * We deliberately do NOT also call the bot to cancel server-side. Two reasons:
 *   1. The friend's prompt has no expiry; even a "this was cancelled" reply
 *      doesn't undo the social interruption that already happened.
 *   2. Keeping cancel local-only keeps the desktop responsive even if the bot
 *      is unreachable. The user re-requesting later mints a fresh reqId.
 */
export function cancelPendingUninstallRequest(): { ok: boolean; error?: string } {
  const schedule = loadSchedule();
  if (!schedule.delegation) return { ok: false, error: 'No friend lock active' };
  if (!schedule.delegation.pendingUninstallReqId) {
    return { ok: false, error: 'No request is pending' };
  }
  schedule.delegation.pendingUninstallReqId = null;
  saveSchedule(schedule);
  return { ok: true };
}

/**
 * Start the 72h emergency uninstall cooldown. Once started this CANNOT be
 * cancelled — the cooldown is the safety net for friend-vanishes / hostile-friend
 * scenarios, and an "oops, never mind" button would defang it.
 */
export function startEmergencyCooldown(): { ok: boolean; startedAt?: string; error?: string } {
  const schedule = loadSchedule();
  if (!schedule.delegation) return { ok: false, error: 'No friend lock active' };
  if (!canStartEmergencyUninstall(schedule)) {
    return { ok: false, error: 'Emergency cooldown is already in flight' };
  }
  schedule.delegation.emergencyUninstallStartedAt = new Date().toISOString();
  saveSchedule(schedule);
  emitEmergencyCooldownChanged();
  return { ok: true, startedAt: schedule.delegation.emergencyUninstallStartedAt };
}

/**
 * Snapshot of "can the user uninstall right now?" — sent to the renderer so
 * the locked-screen can render the right buttons. Cheap; safe to call on every
 * UI tick.
 */
export interface UninstallGateStatus {
  gate: UninstallGate;
  pendingUninstallReqId: string | null;
  lastDecisionVerdict: 'approved' | 'denied' | null;
  emergencyCooldownStartedAt: string | null;
  emergencyCooldownRemainingMs: number;
}

export function getUninstallGateStatus(): UninstallGateStatus {
  const schedule = loadSchedule();
  return {
    gate: uninstallGate(schedule),
    pendingUninstallReqId: schedule.delegation?.pendingUninstallReqId ?? null,
    lastDecisionVerdict: schedule.delegation?.lastUninstallDecision?.verdict ?? null,
    emergencyCooldownStartedAt: schedule.delegation?.emergencyUninstallStartedAt ?? null,
    emergencyCooldownRemainingMs: emergencyCooldownRemainingMs(schedule),
  };
}

/** Mirror of bot/src/crypto.ts botMessagePreimage. Same canonical-JSON rules. */
function botMessagePreimage(pairingId: string, seq: number, kind: string, payload: unknown): string {
  return `v2|${pairingId}|${seq}|${kind}|${canonicalJson(payload)}`;
}

/** Canonical JSON: sorted object keys at every depth, preserve array order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/** Best-effort fetch with a hard timeout. */
async function fetchJson(url: string, body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '<unreadable>');
      throw new Error(`HTTP ${r.status}: ${text}`);
    }
    return r.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// IPC events to renderer

function emitPhaseChanged(phase: DelegationPhase | null): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('friendlock:phaseChanged', phase);
  }
}

function emitFriendPaired(friendName: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('friendlock:friendPaired', { friendName });
  }
}

function emitBotUnreachable(sinceMs: number): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('friendlock:botUnreachable', { since: sinceMs });
  }
}

function emitUninstallDecision(verdict: 'approved' | 'denied', reqId: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('friendlock:uninstallDecision', { verdict, reqId });
  }
}

function emitEmergencyCooldownChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('friendlock:emergencyCooldownChanged');
  }
}
