package com.nightowl

import kotlinx.serialization.Serializable
import java.time.Instant

/**
 * Circles Phase 1 — multi-device Accounts (Kotlin mirror of
 * `packages/shared/src/account.ts`).
 *
 * Mission invariant: "schedule lock enforcement no matter what" must hold across
 * ALL of a person's devices. An [Account] groups N device public keys under one
 * schedule + one lock; curfew compliance is judged across EVERY registered device
 * so a second screen can't defeat the lock.
 *
 * Wire format is shared with the bot + desktop; CODE is not (same rule as
 * [CanonicalJson] / [Identity]). The logic here is a byte-for-byte port of the
 * unit-tested TypeScript in @nightowl/shared. SCAFFOLD: not yet wired into the
 * enforcement loop — compile-verified, pending real-device validation.
 */

@Serializable
data class AccountDevice(
    val devicePubkeyHex: String,
    val label: String,
    val attachedAt: String,
    val lastHeartbeatAt: String? = null,
    val lastEnforcing: Boolean = false,
)

@Serializable
data class Account(
    val accountId: String,
    val createdAt: String,
    val devices: List<AccountDevice>,
)

const val MAX_DEVICES_PER_ACCOUNT = 10

/** Doze-tolerant freshness window for an enforcement heartbeat. */
const val HEARTBEAT_STALE_MS = 15L * 60L * 1000L

private val HEX64 = Regex("^[0-9a-f]{64}$")

/** Result of an account mutation — success carries the new account, failure a reason. */
sealed class AccountMutation {
    data class Ok(val account: Account) : AccountMutation()
    data class Err(val reason: String) : AccountMutation()
}

fun makeAccount(accountId: String, devicePubkeyHex: String, label: String, nowIso: String = Instant.now().toString()): Account =
    Account(
        accountId = accountId,
        createdAt = nowIso,
        devices = listOf(AccountDevice(devicePubkeyHex, label, attachedAt = nowIso)),
    )

fun findDevice(account: Account, devicePubkeyHex: String): AccountDevice? =
    account.devices.firstOrNull { it.devicePubkeyHex == devicePubkeyHex }

/** Additive — never mutates the input. Caller must have verified an existing-device-confirmed join code (R3). */
fun attachDevice(account: Account, devicePubkeyHex: String, label: String, nowIso: String = Instant.now().toString()): AccountMutation {
    if (!HEX64.matches(devicePubkeyHex)) return AccountMutation.Err("devicePubkeyHex must be 64 lowercase hex chars")
    if (findDevice(account, devicePubkeyHex) != null) return AccountMutation.Err("device already attached to this account")
    if (account.devices.size >= MAX_DEVICES_PER_ACCOUNT) return AccountMutation.Err("account already at the $MAX_DEVICES_PER_ACCOUNT-device limit")
    return AccountMutation.Ok(account.copy(devices = account.devices + AccountDevice(devicePubkeyHex, label, attachedAt = nowIso)))
}

/**
 * Pure transition only — does NOT enforce authorization. Per design R4, detach is a
 * release-class action the caller MUST gate behind the account's release threshold.
 */
fun detachDevice(account: Account, devicePubkeyHex: String): AccountMutation {
    if (findDevice(account, devicePubkeyHex) == null) return AccountMutation.Err("device not attached to this account")
    if (account.devices.size <= 1) return AccountMutation.Err("cannot detach the last device — an account must keep at least one")
    return AccountMutation.Ok(account.copy(devices = account.devices.filterNot { it.devicePubkeyHex == devicePubkeyHex }))
}

fun recordHeartbeat(account: Account, devicePubkeyHex: String, enforcing: Boolean, nowIso: String = Instant.now().toString()): AccountMutation {
    if (findDevice(account, devicePubkeyHex) == null) return AccountMutation.Err("heartbeat from a device not attached to this account")
    return AccountMutation.Ok(
        account.copy(
            devices = account.devices.map {
                if (it.devicePubkeyHex == devicePubkeyHex) it.copy(lastHeartbeatAt = nowIso, lastEnforcing = enforcing) else it
            },
        ),
    )
}

enum class CoverageReason { ENFORCING, STALE, NOT_ENFORCING, NEVER_REPORTED }

data class DeviceCoverage(
    val devicePubkeyHex: String,
    val label: String,
    val covered: Boolean,
    val reason: CoverageReason,
)

enum class ComplianceStatus { KEPT, COVERAGE_GAP }

data class CurfewCompliance(
    val status: ComplianceStatus,
    val devices: List<DeviceCoverage>,
    val gapDevices: List<String>,
)

private fun parseIsoMs(iso: String?): Long? =
    if (iso == null) null else try { Instant.parse(iso).toEpochMilli() } catch (e: Exception) { null }

/**
 * Judge curfew compliance across the whole account (design R5). 'kept' only when
 * EVERY registered device has a fresh heartbeat AND reported enforcing; anything
 * else (never reported / stale / not enforcing) is a coverage gap. This is what
 * makes "a second device cannot defeat curfew" true.
 */
fun curfewCompliance(account: Account, nowMs: Long = System.currentTimeMillis(), staleMs: Long = HEARTBEAT_STALE_MS): CurfewCompliance {
    val devices = account.devices.map { d ->
        val beatMs = parseIsoMs(d.lastHeartbeatAt)
        val reason = when {
            d.lastHeartbeatAt == null -> CoverageReason.NEVER_REPORTED
            beatMs == null || nowMs - beatMs >= staleMs -> CoverageReason.STALE
            !d.lastEnforcing -> CoverageReason.NOT_ENFORCING
            else -> CoverageReason.ENFORCING
        }
        DeviceCoverage(d.devicePubkeyHex, d.label, covered = reason == CoverageReason.ENFORCING, reason = reason)
    }
    val gapDevices = devices.filterNot { it.covered }.map { it.devicePubkeyHex }
    return CurfewCompliance(
        status = if (gapDevices.isEmpty()) ComplianceStatus.KEPT else ComplianceStatus.COVERAGE_GAP,
        devices = devices,
        gapDevices = gapDevices,
    )
}

/** Streak math: kept extends, any gap resets to 0. */
fun nextStreak(prevStreak: Int, status: ComplianceStatus): Int =
    if (status == ComplianceStatus.KEPT) prevStreak + 1 else 0

@Serializable
data class CurfewReportPayload(
    val accountId: String,
    val dateIso: String,
    val status: String, // "kept" | "coverage_gap" — matches shared wire literal
    val streak: Int,
    val deviceCount: Int,
    val gapCount: Int,
)

fun buildCurfewReport(account: Account, prevStreak: Int, nowMs: Long = System.currentTimeMillis(), staleMs: Long = HEARTBEAT_STALE_MS): CurfewReportPayload {
    val compliance = curfewCompliance(account, nowMs, staleMs)
    val statusLiteral = if (compliance.status == ComplianceStatus.KEPT) "kept" else "coverage_gap"
    return CurfewReportPayload(
        accountId = account.accountId,
        dateIso = Instant.ofEpochMilli(nowMs).toString(),
        status = statusLiteral,
        streak = nextStreak(prevStreak, compliance.status),
        deviceCount = account.devices.size,
        gapCount = compliance.gapDevices.size,
    )
}
