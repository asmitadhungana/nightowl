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
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import java.time.Instant
import java.util.UUID

/**
 * UI state for the home screen. The schedule lives in [ScheduleStore] and focus
 * session in [FocusStore]; we pull both through here as `savedSchedule` / `focus`.
 *
 * The editor (`editorDays`, `editorLockDays`, `editorTimezone`) is in-progress UI
 * state separate from `savedSchedule` so the bot poll loop writing to the schedule
 * doesn't trample unsaved edits.
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
    val focus: FocusSession = FocusSession(),
    val uninstallGate: DelegationGate = DelegationGate.Blocked("not delegated"),
    val focusReleaseGate: DelegationGate = DelegationGate.Blocked("no focus session"),
    val emergencyCooldownRemainingMs: Long = 0,
    val editorDays: Map<String, DaySchedule> = emptyMap(),
    val editorTimezone: String = "UTC",
    val editorLockDays: Int = 7,
    val editorDirty: Boolean = false,
    /** Whatever the user typed into the allowlist add-input. Local UI state. */
    val allowlistInput: String = "",
    val lastError: String? = null,
    val lastMessage: String? = null,
)

class HomeViewModel(private val appCtx: Context) : ViewModel() {

    private val identity = Identity.loadOrCreate(appCtx)
    private val store = ScheduleStore(appCtx)
    private val focusStore = FocusStore(appCtx)
    private val client = BotClient(identity)

    private val _state = MutableStateFlow(HomeState())
    val state: StateFlow<HomeState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            // Combine schedule + focus into a single state-update path. Both stores can
            // write concurrently (poll loop touches schedule, focus countdown touches
            // focus) — `combine` gives us a fresh derived state on either change.
            store.schedule.combine(focusStore.session) { s, f -> s to f }.collect { (sched, focus) ->
                _state.value = _state.value.copy(
                    pairingId = sched.delegation?.pairingId,
                    phase = sched.delegation?.phase,
                    friendName = sched.delegation?.friendName,
                    savedSchedule = sched,
                    focus = focus,
                    uninstallGate = uninstallGate(sched),
                    focusReleaseGate = focusReleaseGate(sched, focus),
                    emergencyCooldownRemainingMs = emergencyCooldownRemainingMs(sched),
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

    // ---------------------------------------------------------------------------
    // A3: uninstall flow + 72h emergency cooldown
    // ---------------------------------------------------------------------------

    /** Ask the friend to /approve uninstall. Mints a fresh reqId; idempotent on retry. */
    fun requestUninstall() {
        viewModelScope.launch {
            val pairingId = _state.value.pairingId ?: run {
                _state.value = _state.value.copy(lastError = "No active delegation — nothing to request.")
                return@launch
            }
            val reqId = UUID.randomUUID().toString()
            try {
                client.requestUninstall(pairingId, reqId)
                store.update { sched ->
                    val d = sched.delegation ?: return@update sched
                    sched.copy(delegation = d.copy(pendingUninstallReqId = reqId))
                }
                _state.value = _state.value.copy(
                    lastError = null,
                    lastMessage = "Asked your friend. Watch for the decision (usually within 10s of them /approve'ing).",
                )
            } catch (e: Exception) {
                _state.value = _state.value.copy(lastError = "Couldn't reach the bot: ${e.message ?: e::class.simpleName}")
            }
        }
    }

    /** Cancel the in-flight request locally. The friend's prompt may still arrive; safe to ignore. */
    fun cancelPendingUninstallRequest() {
        viewModelScope.launch {
            store.update { sched ->
                val d = sched.delegation ?: return@update sched
                sched.copy(delegation = d.copy(pendingUninstallReqId = null))
            }
            _state.value = _state.value.copy(lastMessage = "Cancelled. Your friend can still respond; we'll just ignore it.")
        }
    }

    /**
     * Start the 72h emergency cooldown. **Cannot be cancelled** once started — same
     * invariant as desktop. The UI should hard-confirm with the user before calling
     * this; we still re-check here.
     */
    fun startEmergencyCooldown() {
        viewModelScope.launch {
            val sched = store.current()
            if (!canStartEmergencyUninstall(sched)) {
                _state.value = _state.value.copy(lastError = "Emergency cooldown is not available right now.")
                return@launch
            }
            store.update { s ->
                val d = s.delegation ?: return@update s
                s.copy(delegation = d.copy(emergencyUninstallStartedAt = Instant.now().toString()))
            }
            _state.value = _state.value.copy(
                lastError = null,
                lastMessage = "72h emergency cooldown started. Uninstall will be allowed when the timer elapses. Cannot be cancelled.",
            )
        }
    }

    /**
     * "Uninstall now" — clear the delegation + deactivate the schedule + stop
     * enforcement so the user can manually uninstall the APK from Settings.
     * Gated by [uninstallGate]; refuses unless `allowed`.
     *
     * Android can't uninstall its own APK without a system PackageInstaller
     * intent + user confirmation. This action does the soft-uninstall (turns off
     * all enforcement); the user then completes the actual APK removal via
     * Settings → Apps → NightOwl → Uninstall. Documented in the UI copy.
     */
    fun softUninstall() {
        viewModelScope.launch {
            val sched = store.current()
            val gate = uninstallGate(sched)
            if (gate !is DelegationGate.Allowed) {
                _state.value = _state.value.copy(lastError = "Uninstall blocked: ${gate.reason}")
                return@launch
            }
            store.update { s ->
                s.copy(active = false, lockEndDate = null, delegation = null)
            }
            focusStore.stop()
            _state.value = _state.value.copy(
                lastError = null,
                lastMessage = "Lock released. Open Settings → Apps → NightOwl → Uninstall to remove the app entirely.",
            )
        }
    }

    // ---------------------------------------------------------------------------
    // A3: Friend Focus
    // ---------------------------------------------------------------------------

    /**
     * Start a focus session. `friendGated=true` requires an active friend pairing —
     * otherwise the user has no one to ask for early release. Solo sessions are
     * uncancellable until elapsed.
     */
    fun startFocus(durationMinutes: Int, friendGated: Boolean) {
        viewModelScope.launch {
            if (durationMinutes !in 1..(8 * 60)) {
                _state.value = _state.value.copy(lastError = "Focus duration must be 1–480 minutes.")
                return@launch
            }
            if (friendGated && _state.value.phase != DelegationPhase.active) {
                _state.value = _state.value.copy(lastError = "Friend-gated focus needs an active friend pairing first.")
                return@launch
            }
            val started = focusStore.start(durationMinutes, friendGated)
            if (!started) {
                _state.value = _state.value.copy(lastError = "A focus session is already active.")
                return@launch
            }
            _state.value = _state.value.copy(
                lastError = null,
                lastMessage = "Focus armed for $durationMinutes minutes. Apps will bounce back to home.",
            )
        }
    }

    fun requestFocusRelease() {
        viewModelScope.launch {
            val pairingId = _state.value.pairingId ?: return@launch
            val focus = _state.value.focus
            if (!focus.active || focus.isElapsed()) {
                _state.value = _state.value.copy(lastError = "No active focus session.")
                return@launch
            }
            if (!focus.friendGated) {
                _state.value = _state.value.copy(lastError = "Solo focus session — wait the timer out.")
                return@launch
            }
            val reqId = UUID.randomUUID().toString()
            try {
                client.requestFocusRelease(
                    pairingId = pairingId,
                    reqId = reqId,
                    focusMinutes = focus.durationMinutes,
                    focusStartedAt = focus.startedAt ?: Instant.now().toString(),
                )
                focusStore.update { it.copy(pendingReleaseReqId = reqId) }
                _state.value = _state.value.copy(
                    lastError = null,
                    lastMessage = "Asked your friend to release. Watch for the verdict.",
                )
            } catch (e: Exception) {
                _state.value = _state.value.copy(lastError = "Couldn't reach the bot: ${e.message ?: e::class.simpleName}")
            }
        }
    }

    fun cancelPendingFocusRelease() {
        viewModelScope.launch {
            focusStore.update { it.copy(pendingReleaseReqId = null) }
            _state.value = _state.value.copy(lastMessage = "Cancelled the focus-release request locally.")
        }
    }

    fun endFocusEarly() {
        viewModelScope.launch {
            val sched = store.current()
            val focus = focusStore.current()
            val gate = focusReleaseGate(sched, focus)
            if (gate !is DelegationGate.Allowed) {
                _state.value = _state.value.copy(lastError = "Can't end focus early: ${gate.reason}")
                return@launch
            }
            focusStore.stop()
            _state.value = _state.value.copy(lastError = null, lastMessage = "Focus session ended.")
        }
    }

    // ---------------------------------------------------------------------------
    // A3: User-managed allowlist
    // ---------------------------------------------------------------------------

    fun setAllowlistInput(input: String) {
        _state.value = _state.value.copy(allowlistInput = input)
    }

    fun addAllowlistEntry() {
        viewModelScope.launch {
            val pkg = _state.value.allowlistInput.trim()
            if (pkg.isEmpty()) return@launch
            if (!PACKAGE_REGEX.matches(pkg)) {
                _state.value = _state.value.copy(lastError = "`$pkg` doesn't look like a package name (e.g. com.example.app).")
                return@launch
            }
            if (pkg in AppBlockerService.HARDCODED_ALLOWLIST) {
                _state.value = _state.value.copy(lastError = "`$pkg` is already allowed by default.")
                return@launch
            }
            store.update { sched ->
                if (pkg in sched.userAllowlist) sched
                else sched.copy(userAllowlist = sched.userAllowlist + pkg)
            }
            _state.value = _state.value.copy(
                allowlistInput = "",
                lastError = null,
                lastMessage = "Added `$pkg` to the allowlist.",
            )
        }
    }

    fun removeAllowlistEntry(pkg: String) {
        viewModelScope.launch {
            store.update { sched -> sched.copy(userAllowlist = sched.userAllowlist - pkg) }
            _state.value = _state.value.copy(lastMessage = "Removed `$pkg` from the allowlist.")
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
        /** Coarse package-name shape check: at least one dot, lowercase letters/digits/dots/underscores. */
        private val PACKAGE_REGEX = Regex("^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$")
    }
}
