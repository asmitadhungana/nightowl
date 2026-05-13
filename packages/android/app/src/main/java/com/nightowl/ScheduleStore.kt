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

/**
 * Curfew schedule + pairing state, persisted to the app's private DataStore.
 *
 * Structurally mirrors [packages/shared/src/types.ts]'s Schedule but lives in a
 * Kotlin world. We do NOT share serialization with the desktop — Android sees
 * only its own copy, and the bot is the source of truth across both.
 *
 * Curfew windows are stored as 24-hour HH:MM strings; null means "no curfew that day".
 * An overnight curfew (e.g. 22:00 → 06:00) is the responsibility of the consumer to
 * interpret — see [Schedule.isCurfewActive].
 */
@Serializable
data class DaySchedule(val curfewStart: String? = null, val curfewEnd: String? = null)

@Serializable
data class DelegationState(
    val pairingId: String,
    val lastSeq: Long = 0,
    val approvalGranted: Boolean = false,
    val approvalReqId: String? = null,
)

@Serializable
data class Schedule(
    val active: Boolean = false,
    val lockEndDate: String? = null,
    val days: Map<String, DaySchedule> = emptyMap(),
    val timezone: String = "UTC",
    val delegation: DelegationState? = null,
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
