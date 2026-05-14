package com.nightowl

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * UI state for the home screen. The schedule itself lives in [ScheduleStore] —
 * we pull it through here as `editorDays` (an in-progress copy the editor mutates)
 * separately from `savedSchedule` (the persisted version the enforcement service
 * reads). Pressing "Save schedule" copies editorDays → savedSchedule.
 */
data class HomeState(
    val pairCode: String? = null,
    val pairingId: String? = null,
    val phase: DelegationPhase? = null,
    val friendName: String? = null,
    val deviceAdminActive: Boolean = false,
    val accessibilityActive: Boolean = false,
    val serviceRunning: Boolean = false,
    val savedSchedule: Schedule = Schedule(),
    val editorDays: Map<String, DaySchedule> = emptyMap(),
    val editorTimezone: String = "UTC",
    val editorLockDays: Int = 7,
    val editorDirty: Boolean = false,
    val lastError: String? = null,
    val lastMessage: String? = null,
)

class HomeViewModel(private val appCtx: Context) : ViewModel() {

    private val identity = Identity.loadOrCreate(appCtx)
    private val store = ScheduleStore(appCtx)
    private val client = BotClient(identity)

    private val _state = MutableStateFlow(HomeState())
    val state: StateFlow<HomeState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            store.schedule.collect { sched ->
                // Refresh from persisted store, but DON'T trample editor edits in progress.
                _state.value = _state.value.copy(
                    pairingId = sched.delegation?.pairingId,
                    phase = sched.delegation?.phase,
                    friendName = sched.delegation?.friendName,
                    savedSchedule = sched,
                    editorDays = if (_state.value.editorDirty) _state.value.editorDays else seedEditorDays(sched),
                    editorTimezone = if (_state.value.editorDirty) _state.value.editorTimezone else sched.timezone.ifBlank { defaultTimezone() },
                )
                refreshPermissionFlags()
            }
        }
    }

    fun refreshPermissionFlags() {
        val dpm = appCtx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val admin = ComponentName(appCtx, NightOwlDeviceAdminReceiver::class.java)
        _state.value = _state.value.copy(
            deviceAdminActive = dpm.isAdminActive(admin),
            accessibilityActive = AppBlockerService.isEnabled(appCtx),
        )
    }

    fun enroll() {
        viewModelScope.launch {
            try {
                val resp = client.enroll()
                store.update { it.copy(delegation = DelegationState(pairingId = resp.pairingId, phase = DelegationPhase.enrolled)) }
                _state.value = _state.value.copy(
                    pairCode = resp.pairCode,
                    pairingId = resp.pairingId,
                    lastError = null,
                    lastMessage = "Pair code generated. Share with your locker.",
                )
            } catch (e: Exception) {
                _state.value = _state.value.copy(lastError = e.message ?: e::class.simpleName)
            }
        }
    }

    fun setDayEnabled(dayKey: String, enabled: Boolean) {
        val current = _state.value.editorDays.toMutableMap()
        current[dayKey] = if (enabled) DaySchedule("22:00", "06:00") else DaySchedule(null, null)
        _state.value = _state.value.copy(editorDays = current, editorDirty = true)
    }

    fun setDayStart(dayKey: String, hhmm: String) {
        val current = _state.value.editorDays.toMutableMap()
        val existing = current[dayKey] ?: DaySchedule()
        current[dayKey] = existing.copy(curfewStart = hhmm.ifBlank { null })
        _state.value = _state.value.copy(editorDays = current, editorDirty = true)
    }

    fun setDayEnd(dayKey: String, hhmm: String) {
        val current = _state.value.editorDays.toMutableMap()
        val existing = current[dayKey] ?: DaySchedule()
        current[dayKey] = existing.copy(curfewEnd = hhmm.ifBlank { null })
        _state.value = _state.value.copy(editorDays = current, editorDirty = true)
    }

    fun copyMondayToAll() {
        val mon = _state.value.editorDays["monday"] ?: return
        val copied = DAY_KEYS.associateWith { mon }
        _state.value = _state.value.copy(editorDays = copied, editorDirty = true, lastMessage = "Copied Monday's times to all days.")
    }

    fun applyPreset(name: String) {
        val days = when (name) {
            "night_owl" -> Presets.NightOwl
            "early_bird" -> Presets.EarlyBird
            "weekend_flex" -> Presets.WeekendFlex
            else -> return
        }
        _state.value = _state.value.copy(editorDays = days, editorDirty = true, lastMessage = "Preset applied: $name. Review then activate.")
    }

    fun setLockDays(days: Int) {
        _state.value = _state.value.copy(editorLockDays = days, editorDirty = true)
    }

    fun saveSchedule() {
        viewModelScope.launch {
            val validation = validateEditorDays(_state.value.editorDays)
            if (validation != null) {
                _state.value = _state.value.copy(lastError = validation)
                return@launch
            }
            store.update { it.copy(days = _state.value.editorDays, timezone = _state.value.editorTimezone) }
            _state.value = _state.value.copy(editorDirty = false, lastError = null, lastMessage = "Schedule saved. Activate when you're ready.")
        }
    }

    /**
     * Flip [Schedule.active] to true and stamp `lockEndDate`. Gated on:
     *   - Device admin granted (else the curfew tick can't call lockNow()).
     *   - Friend delegation in `active` phase (else there's no password — anyone with
     *     this phone could just turn the schedule off again).
     *
     * The accessibility service is **recommended but not required** — without it
     * curfew enforcement degrades to "screen-lock only, no app blocking", which
     * matches the A1 behavior. Surface that in the UI as a warning, not a gate.
     */
    fun activateSchedule() {
        viewModelScope.launch {
            val cur = _state.value
            if (!cur.deviceAdminActive) {
                _state.value = cur.copy(lastError = "Grant device admin first — without it, curfew can't lock the screen.")
                return@launch
            }
            if (cur.phase != DelegationPhase.active) {
                _state.value = cur.copy(lastError = "Friend hasn't set the lock password yet. Wait for `/setpassword` over Telegram, or re-pair if pairing is stuck.")
                return@launch
            }
            if (cur.editorDirty) {
                _state.value = cur.copy(lastError = "Unsaved schedule changes. Save first, then activate.")
                return@launch
            }
            store.update {
                it.copy(active = true, lockEndDate = lockEndDateIn(cur.editorLockDays))
            }
            _state.value = _state.value.copy(lastError = null, lastMessage = "Curfew armed for ${cur.editorLockDays} days. Good luck.")
        }
    }

    fun clearMessage() {
        _state.value = _state.value.copy(lastError = null, lastMessage = null)
    }

    private fun seedEditorDays(sched: Schedule): Map<String, DaySchedule> {
        if (sched.days.isNotEmpty()) return DAY_KEYS.associateWith { sched.days[it] ?: DaySchedule() }
        return DAY_KEYS.associateWith { DaySchedule() }
    }

    private fun defaultTimezone(): String = runCatching { java.util.TimeZone.getDefault().id }.getOrDefault("UTC")

    /** Returns an error string, or null if valid. */
    private fun validateEditorDays(days: Map<String, DaySchedule>): String? {
        for ((k, v) in days) {
            val s = v.curfewStart
            val e = v.curfewEnd
            // Either both unset (day off) or both must be valid HH:MM.
            if ((s == null) != (e == null)) {
                return "$k: set both start and end, or leave both blank."
            }
            if (s != null && !HHMM_REGEX.matches(s)) return "$k start `$s` must be HH:MM in 24-hour."
            if (e != null && !HHMM_REGEX.matches(e)) return "$k end `$e` must be HH:MM in 24-hour."
            if (s != null && e != null && s == e) return "$k: start and end are equal — would be a 24-hour curfew."
        }
        return null
    }

    class Factory(private val appCtx: Context) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = HomeViewModel(appCtx) as T
    }

    companion object {
        private val HHMM_REGEX = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")
    }
}
