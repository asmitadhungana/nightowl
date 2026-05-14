package com.nightowl

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * Curfew schedule + pairing state, persisted to the app's private DataStore.
 *
 * Structurally mirrors `packages/shared/src/types.ts` + `packages/shared/src/delegation.ts`
 * on the desktop, but in a Kotlin world. We do NOT share serialization with the
 * desktop — Android sees only its own copy, and the bot is the source of truth
 * across both.
 *
 * Curfew windows are stored as 24-hour HH:MM strings; null means "no curfew that day".
 * An overnight curfew (e.g. 22:00 → 06:00) is the responsibility of the consumer to
 * interpret — see [Schedule.isCurfewActive].
 */
@Serializable
data class DaySchedule(val curfewStart: String? = null, val curfewEnd: String? = null)

/**
 * Mirrors `DelegationPhase` in `packages/shared/src/delegation.ts`.
 *
 *   enrolled          — `/desktop/enroll` succeeded; friend hasn't typed `/pair`.
 *   paired            — friend `/pair`'d; we know their name + chat id.
 *   awaiting_password — same as paired but friend hasn't `/setpassword` yet.
 *   active            — `password_hash` arrived + signature verified.
 *   revoked           — friend `/revoke`'d. Lock continues; only escape is the 72h cooldown.
 */
@Serializable
enum class DelegationPhase { enrolled, paired, awaiting_password, active, revoked }

@Serializable
data class UninstallVerdict(
    val reqId: String,
    val verdict: String, // "approved" | "denied"
    val decidedAt: String,
)

@Serializable
data class DelegationState(
    val pairingId: String,
    val friendName: String? = null,
    val friendChatId: String? = null,
    val pairedAt: String? = null,
    val lastConsumedSeq: Long = 0,
    val phase: DelegationPhase = DelegationPhase.enrolled,
    /** bcrypt hash of the lock password — set when [phase] flips to `active`. Never plaintext. */
    val passwordHash: String? = null,
    val passwordSetAt: String? = null,
    /**
     * UUID of the in-flight uninstall request awaiting friend approval. Null whenever
     * no request is pending or the most recent one is decided. Cleared on
     * `cancelPendingUninstallRequest` or when the matching `uninstall_decision`
     * arrives via the poll loop.
     */
    val pendingUninstallReqId: String? = null,
    /**
     * ISO timestamp when the user started the 72h emergency uninstall cooldown.
     * Null if cooldown is not active. **Once started, cannot be cancelled** — that
     * keeps the safety net from being defanged by a hostile-friend scenario (see
     * CLAUDE.md § v2 "Load-bearing invariants").
     */
    val emergencyUninstallStartedAt: String? = null,
    /** Most recent uninstall verdict. Persisted so a restart doesn't lose it. */
    val lastUninstallDecision: UninstallVerdict? = null,
    /** Most recent focus-release verdict. */
    val lastFocusReleaseDecision: UninstallVerdict? = null,
    val friendRevokedAt: String? = null,
)

@Serializable
data class Schedule(
    val active: Boolean = false,
    val lockEndDate: String? = null,
    val days: Map<String, DaySchedule> = emptyMap(),
    val timezone: String = "UTC",
    val delegation: DelegationState? = null,
    /**
     * User-managed additions to [AppBlockerService.HARDCODED_ALLOWLIST]. The defaults
     * (system UI, Settings, dialer, launcher) are NOT in this list — they're always
     * allowed. This list only adds; it cannot subtract from defaults. Empty by
     * default; user populates from the Allowlist card in the UI.
     */
    val userAllowlist: List<String> = emptyList(),
) {
    /**
     * Naive curfew check using the device's current wall clock. Overnight windows
     * (start > end, e.g. 22:00–06:00) are handled by checking whether `now` falls
     * EITHER after start OR before end on the same day.
     *
     * `nowHHMM` must be 24-hour HH:MM ("23:42"), `dayKey` lowercase ISO weekday
     * ("monday").
     */
    fun isCurfewActive(dayKey: String, nowHHMM: String): Boolean {
        if (!active) return false
        val day = days[dayKey] ?: return false
        val start = day.curfewStart ?: return false
        val end = day.curfewEnd ?: return false
        return if (start <= end) {
            nowHHMM in start..end
        } else {
            // Overnight (22:00–06:00). Active when after start OR before end.
            nowHHMM >= start || nowHHMM <= end
        }
    }
}

/** Lowercase ISO weekday names in display order. Stable across the app — used as map keys. */
val DAY_KEYS: List<String> = listOf("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")

/**
 * Built-in presets — same shape as the macOS web UI's "Night Owl / Early Bird / Weekend Flex"
 * buttons, ported by feel rather than by copy-paste from server.js.
 */
object Presets {
    val NightOwl: Map<String, DaySchedule> = DAY_KEYS.associateWith { DaySchedule("22:00", "06:00") }
    val EarlyBird: Map<String, DaySchedule> = DAY_KEYS.associateWith { DaySchedule("21:00", "05:00") }
    val WeekendFlex: Map<String, DaySchedule> = mapOf(
        "monday"    to DaySchedule("22:00", "06:00"),
        "tuesday"   to DaySchedule("22:00", "06:00"),
        "wednesday" to DaySchedule("22:00", "06:00"),
        "thursday"  to DaySchedule("22:00", "06:00"),
        "friday"    to DaySchedule("23:30", "07:00"),
        "saturday"  to DaySchedule("23:30", "07:00"),
        "sunday"    to DaySchedule("22:00", "06:00"),
    )
}

/** Compute an ISO-8601 lockEndDate `days` from now. */
fun lockEndDateIn(days: Int): String =
    Instant.now().plus(days.toLong(), ChronoUnit.DAYS).toString()

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore("nightowl_schedule")
private val SCHEDULE_KEY = stringPreferencesKey("schedule_json")
private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

class ScheduleStore(private val ctx: Context) {

    val schedule: Flow<Schedule> = ctx.dataStore.data.map { prefs ->
        prefs[SCHEDULE_KEY]?.let { runCatching { json.decodeFromString<Schedule>(it) }.getOrNull() }
            ?: Schedule()
    }

    suspend fun current(): Schedule = schedule.first()

    suspend fun update(transform: (Schedule) -> Schedule) {
        ctx.dataStore.edit { prefs ->
            val cur = prefs[SCHEDULE_KEY]?.let { json.decodeFromString<Schedule>(it) } ?: Schedule()
            prefs[SCHEDULE_KEY] = json.encodeToString(transform(cur))
        }
    }
}
