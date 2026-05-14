package com.nightowl

import java.time.Instant

/**
 * Kotlin port of `packages/shared/src/delegation.ts` — the gate predicates that
 * answer "may the user uninstall right now?" and "may they end this focus session
 * early?" These are the single source of truth on the desktop and on Android.
 *
 * Wire-compat: payload shapes + message kinds are shared with desktop via the bot.
 * Code is NOT shared — Kotlin↔TypeScript bridging adds more weight than re-deriving
 * 100 LOC of branch logic. If the desktop's `delegation.ts` changes, mirror it here.
 *
 * The return type is a sealed class instead of TypeScript's discriminated union;
 * functionally identical. `reason` is the user-facing string — keep it actionable.
 */
sealed class DelegationGate {
    abstract val reason: String

    data class Allowed(override val reason: String) : DelegationGate()
    data class Blocked(override val reason: String) : DelegationGate()
}

/** 72 hours in milliseconds. Matches `EMERGENCY_COOLDOWN_MS` in `packages/shared/src/delegation.ts`. */
const val EMERGENCY_COOLDOWN_MS: Long = 72L * 60L * 60L * 1000L

/** True iff this schedule is being held under a friend's keys (not a self-set lock). */
fun isDelegated(s: Schedule): Boolean = s.delegation != null

/**
 * Milliseconds remaining in the emergency cooldown. Returns 0 when no cooldown is
 * active or it has already elapsed.
 */
fun emergencyCooldownRemainingMs(s: Schedule, nowMs: Long = System.currentTimeMillis()): Long {
    val startedAt = s.delegation?.emergencyUninstallStartedAt ?: return 0
    val startMs = runCatching { Instant.parse(startedAt).toEpochMilli() }.getOrNull() ?: return 0
    val remaining = startMs + EMERGENCY_COOLDOWN_MS - nowMs
    return remaining.coerceAtLeast(0)
}

/**
 * True iff the user is allowed to START an emergency uninstall right now. Requires
 * a delegated lock with no cooldown already in flight. The 72h timer, once started,
 * is non-cancellable by design (see CLAUDE.md § v2 "Load-bearing invariants").
 */
fun canStartEmergencyUninstall(s: Schedule): Boolean {
    if (!isDelegated(s)) return false
    return s.delegation?.emergencyUninstallStartedAt == null
}

/**
 * Decide whether `daemon:uninstall` is allowed given current state.
 *
 * Branches (mirroring desktop):
 *   - non-delegated → allowed (caller does the password check; trivial for Android since
 *     v4 always uses delegation)
 *   - pre-active phase → allowed (user can cancel pairing and uninstall freely)
 *   - active + last decision approved → allowed
 *   - active + cooldown elapsed → allowed
 *   - active + cooldown in flight → blocked, hours-remaining surfaced
 *   - active + last decision denied → blocked, "try again or start cooldown"
 *   - active + pending request → blocked, "waiting on friend"
 *   - revoked + no cooldown → blocked, "friend stepped away — start cooldown"
 *
 * @param nowMs injectable for tests; defaults to `System.currentTimeMillis()`.
 */
fun uninstallGate(s: Schedule, nowMs: Long = System.currentTimeMillis()): DelegationGate {
    val d = s.delegation
        ?: return DelegationGate.Allowed("self-set lock — password check applies")

    // Pre-active phases: nothing is enforcing yet.
    if (d.phase != DelegationPhase.active && d.phase != DelegationPhase.revoked) {
        return DelegationGate.Allowed("pairing in flight — cancel pairing instead of uninstalling")
    }

    val last = d.lastUninstallDecision
    if (last != null && last.verdict == "approved") {
        return DelegationGate.Allowed("friend approved at ${last.decidedAt}")
    }

    if (d.emergencyUninstallStartedAt != null) {
        val remaining = emergencyCooldownRemainingMs(s, nowMs)
        if (remaining <= 0) {
            return DelegationGate.Allowed("72h emergency cooldown elapsed")
        }
        val hoursLeft = ((remaining + 1000 * 60 * 60 - 1) / (1000 * 60 * 60)).toInt()
        return DelegationGate.Blocked("Emergency cooldown in progress — ${hoursLeft}h remaining. NightOwl will allow uninstall when it elapses.")
    }

    if (last != null && last.verdict == "denied") {
        return DelegationGate.Blocked("Friend denied your last request. Send a new request, or start the 72h emergency cooldown.")
    }
    if (d.pendingUninstallReqId != null) {
        return DelegationGate.Blocked("Waiting on your friend to /approve or /deny in Telegram. You can also start the 72h emergency cooldown to escape without them.")
    }
    if (d.phase == DelegationPhase.revoked) {
        return DelegationGate.Blocked("Your friend stepped away from this lock. Start the 72h emergency cooldown to uninstall.")
    }
    return DelegationGate.Blocked("Friend Lock is active. Ask your friend to approve uninstall, or start the 72h emergency cooldown.")
}

/**
 * Decide whether a Friend-Focus early release is allowed right now.
 *
 * Solo focus (no friendGated) is uncancellable by design — same v1 contract that
 * still applies. The UI should not even show the "Need out early?" card for solo
 * sessions; this predicate enforces it anyway as a defense-in-depth.
 *
 * Note: there is **no 72h emergency cooldown for focus** — sessions are short
 * (max 8h) so the natural fallback is "wait the timer out." The cooldown is
 * reserved for the schedule lock.
 */
fun focusReleaseGate(s: Schedule, focus: FocusSession): DelegationGate {
    if (!focus.friendGated) {
        return DelegationGate.Blocked("Solo focus session — uncancellable by design.")
    }
    if (!isDelegated(s)) {
        return DelegationGate.Blocked("No friend is paired. Re-pair before starting a friend-gated focus session.")
    }
    val last = focus.lastReleaseDecision
    if (last != null && last.verdict == "approved") {
        return DelegationGate.Allowed("friend approved at ${last.decidedAt}")
    }
    if (last != null && last.verdict == "denied") {
        return DelegationGate.Blocked("Friend denied your last request. Send a new request or wait the timer out.")
    }
    if (focus.pendingReleaseReqId != null) {
        return DelegationGate.Blocked("Waiting on your friend to /approve or /deny in Telegram.")
    }
    return DelegationGate.Blocked("Ask your friend to release this focus session early.")
}
