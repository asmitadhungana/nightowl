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
 * A single focus session — timer-based "extra curfew" the user opts into. Coexists
 * with the schedule lock; while a focus session is active, [EnforcementService]
 * applies the same `lockNow()` + app-blocking enforcement that curfew does.
 *
 * `friendGated` is optional per session. When true, the user can ask their paired
 * friend to release the session early via the bot. When false, the session runs to
 * completion (uncancellable — preserves the v1 Focus contract).
 *
 * Mirrors `FocusSession` in `packages/shared/src/types.ts` on the desktop side. We
 * don't share serialization; bot is the source of truth for cross-device state, but
 * focus sessions are local-only (the desktop and Android each have their own).
 */
@Serializable
data class FocusSession(
    val active: Boolean = false,
    val startedAt: String? = null,
    val endsAt: String? = null,
    val durationMinutes: Int = 0,
    val friendGated: Boolean = false,
    val pendingReleaseReqId: String? = null,
    val lastReleaseDecision: UninstallVerdict? = null,
) {
    /**
     * True iff `now` is past `endsAt`. Caller is responsible for clearing
     * `active` when this returns true.
     */
    fun isElapsed(nowMs: Long = System.currentTimeMillis()): Boolean {
        if (!active) return false
        val end = endsAt ?: return false
        val endMs = runCatching { Instant.parse(end).toEpochMilli() }.getOrNull() ?: return false
        return nowMs >= endMs
    }

    /** Milliseconds remaining; 0 if elapsed or not active. */
    fun remainingMs(nowMs: Long = System.currentTimeMillis()): Long {
        if (!active) return 0
        val end = endsAt ?: return 0
        val endMs = runCatching { Instant.parse(end).toEpochMilli() }.getOrNull() ?: return 0
        return (endMs - nowMs).coerceAtLeast(0)
    }
}

private val Context.focusDataStore: DataStore<Preferences> by preferencesDataStore("nightowl_focus")
private val FOCUS_KEY = stringPreferencesKey("focus_json")
private val focusJson = Json { ignoreUnknownKeys = true; encodeDefaults = true }

class FocusStore(private val ctx: Context) {

    val session: Flow<FocusSession> = ctx.focusDataStore.data.map { prefs ->
        prefs[FOCUS_KEY]?.let { runCatching { focusJson.decodeFromString<FocusSession>(it) }.getOrNull() }
            ?: FocusSession()
    }

    suspend fun current(): FocusSession = session.first()

    suspend fun update(transform: (FocusSession) -> FocusSession) {
        ctx.focusDataStore.edit { prefs ->
            val cur = prefs[FOCUS_KEY]?.let { focusJson.decodeFromString<FocusSession>(it) } ?: FocusSession()
            prefs[FOCUS_KEY] = focusJson.encodeToString(transform(cur))
        }
    }

    /**
     * Start a fresh session. Refuses if one is already active. `friendGated` requires
     * the user to have a paired friend in `active` phase; caller checks (this store
     * is delegation-agnostic on purpose so it can be unit-tested without a Schedule).
     */
    suspend fun start(durationMinutes: Int, friendGated: Boolean): Boolean {
        val cur = current()
        if (cur.active && !cur.isElapsed()) return false
        val now = Instant.now()
        val end = now.plus(durationMinutes.toLong(), ChronoUnit.MINUTES)
        update {
            FocusSession(
                active = true,
                startedAt = now.toString(),
                endsAt = end.toString(),
                durationMinutes = durationMinutes,
                friendGated = friendGated,
                pendingReleaseReqId = null,
                lastReleaseDecision = null,
            )
        }
        return true
    }

    /** Clear the active session. No-op if no session is active. */
    suspend fun stop() {
        update { FocusSession() }
    }
}
