package com.nightowl

import android.util.Log
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Bot inbox poller. Long-running coroutine that periodically calls
 * [BotClient.poll], verifies Ed25519 signatures on each incoming message
 * against the bot's hard-coded public key, then dispatches by [BotMessage.kind].
 *
 * Replay defense: every message must have `seq > delegation.lastConsumedSeq` or
 * it's silently dropped. We advance `lastConsumedSeq` after a successful dispatch.
 *
 * Wire-compat with the macOS / Windows desktop via:
 *   - [botMessagePreimage] format `v2|<pairingId>|<seq>|<kind>|<canonicalJson(payload)>`
 *   - [Identity.verifyBotSignature] using `BOT_PUBKEY_HEX`
 *
 * Cadence: 30s while pre-active (need responsiveness for pair_complete / password_hash),
 * 5min once active (decisions are rare). Doze may stretch these — same caveat as the
 * curfew tick loop, see [EnforcementService].
 */
class PollLoop(
    private val client: BotClient,
    private val store: ScheduleStore,
) {
    suspend fun runForever() {
        while (true) {
            try {
                tickOnce()
            } catch (t: Throwable) {
                Log.w(TAG, "poll tick failed: ${t.message}")
            }
            val cadence = when (store.current().delegation?.phase) {
                DelegationPhase.active, DelegationPhase.revoked, null -> CADENCE_ACTIVE_MS
                else -> CADENCE_PREACTIVE_MS
            }
            delay(cadence)
        }
    }

    private suspend fun tickOnce() {
        val sched = store.current()
        val delegation = sched.delegation ?: return
        val resp = client.poll(delegation.pairingId, delegation.lastConsumedSeq)
        for (msg in resp.messages) {
            handleMessage(delegation.pairingId, msg)
        }
    }

    private suspend fun handleMessage(pairingId: String, msg: BotMessage) {
        val current = store.current().delegation ?: return
        if (msg.seq <= current.lastConsumedSeq) {
            Log.d(TAG, "dropping replayed seq=${msg.seq} (lastConsumed=${current.lastConsumedSeq})")
            return
        }
        val preimage = botMessagePreimage(pairingId, msg.seq, msg.kind, msg.payload)
        if (!Identity.verifyBotSignature(preimage, msg.sig)) {
            Log.w(TAG, "dropping kind=${msg.kind} seq=${msg.seq} — bad signature")
            return
        }
        val payload = msg.payload as? JsonObject
        if (payload == null) {
            Log.w(TAG, "dropping kind=${msg.kind} seq=${msg.seq} — payload not an object")
            // Still advance lastConsumedSeq so we don't get stuck on a bad message.
            store.update { it.copy(delegation = it.delegation?.copy(lastConsumedSeq = msg.seq)) }
            return
        }
        when (msg.kind) {
            "pair_complete" -> applyPairComplete(payload, msg.seq)
            "password_hash" -> applyPasswordHash(payload, msg.seq)
            "friend_revoked" -> applyFriendRevoked(payload, msg.seq)
            "uninstall_decision" -> applyUninstallDecision(payload, msg.seq)
            "focus_release_decision" -> applyFocusReleaseDecision(payload, msg.seq)
            else -> {
                Log.w(TAG, "unknown kind=${msg.kind} seq=${msg.seq}; advancing")
                store.update { it.copy(delegation = it.delegation?.copy(lastConsumedSeq = msg.seq)) }
            }
        }
    }

    private suspend fun applyPairComplete(payload: JsonObject, seq: Long) {
        val name = payload["friendName"]?.jsonPrimitive?.content
        val chat = payload["friendChatId"]?.jsonPrimitive?.content
        store.update { sched ->
            val d = sched.delegation ?: return@update sched
            sched.copy(
                delegation = d.copy(
                    friendName = name,
                    friendChatId = chat,
                    pairedAt = nowIso(),
                    // Desktop advances to `awaiting_password` here — same semantics.
                    phase = DelegationPhase.awaiting_password,
                    lastConsumedSeq = seq,
                ),
            )
        }
    }

    private suspend fun applyPasswordHash(payload: JsonObject, seq: Long) {
        val hash = payload["hash"]?.jsonPrimitive?.content
        val setAt = payload["passwordSetAt"]?.jsonPrimitive?.content
        store.update { sched ->
            val d = sched.delegation ?: return@update sched
            sched.copy(
                delegation = d.copy(
                    passwordHash = hash,
                    passwordSetAt = setAt,
                    phase = DelegationPhase.active,
                    lastConsumedSeq = seq,
                ),
            )
        }
    }

    private suspend fun applyFriendRevoked(payload: JsonObject, seq: Long) {
        val revokedAt = payload["revokedAt"]?.jsonPrimitive?.content ?: nowIso()
        store.update { sched ->
            val d = sched.delegation ?: return@update sched
            sched.copy(
                delegation = d.copy(
                    phase = DelegationPhase.revoked,
                    friendRevokedAt = revokedAt,
                    lastConsumedSeq = seq,
                ),
            )
        }
    }

    private suspend fun applyUninstallDecision(payload: JsonObject, seq: Long) {
        val reqId = payload["reqId"]?.jsonPrimitive?.content ?: return advance(seq)
        val verdict = payload["verdict"]?.jsonPrimitive?.content ?: return advance(seq)
        val decidedAt = payload["decidedAt"]?.jsonPrimitive?.content ?: nowIso()
        store.update { sched ->
            val d = sched.delegation ?: return@update sched
            sched.copy(
                delegation = d.copy(
                    lastUninstallDecision = UninstallVerdict(reqId, verdict, decidedAt),
                    lastConsumedSeq = seq,
                ),
            )
        }
    }

    private suspend fun applyFocusReleaseDecision(payload: JsonObject, seq: Long) {
        val reqId = payload["reqId"]?.jsonPrimitive?.content ?: return advance(seq)
        val verdict = payload["verdict"]?.jsonPrimitive?.content ?: return advance(seq)
        val decidedAt = payload["decidedAt"]?.jsonPrimitive?.content ?: nowIso()
        store.update { sched ->
            val d = sched.delegation ?: return@update sched
            sched.copy(
                delegation = d.copy(
                    lastFocusReleaseDecision = UninstallVerdict(reqId, verdict, decidedAt),
                    lastConsumedSeq = seq,
                ),
            )
        }
    }

    private suspend fun advance(seq: Long) {
        store.update { it.copy(delegation = it.delegation?.copy(lastConsumedSeq = seq)) }
    }

    private fun nowIso(): String = java.time.Instant.now().toString()

    companion object {
        private const val TAG = "NightOwlPollLoop"
        private const val CADENCE_PREACTIVE_MS = 30_000L
        private const val CADENCE_ACTIVE_MS = 5 * 60_000L
    }
}
