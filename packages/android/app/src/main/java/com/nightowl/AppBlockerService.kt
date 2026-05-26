package com.nightowl

import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * Accessibility-service-backed per-app blocker. Activated by the user under
 * Settings → Accessibility → NightOwl. While active, this service receives a
 * [TYPE_WINDOW_STATE_CHANGED] event every time the foreground app changes; if
 * curfew is active and the foreground package is not in the [ALLOWLIST], we
 * call [performGlobalAction] with [GLOBAL_ACTION_HOME] to kick the user back
 * to the launcher.
 *
 * This is the Android counterpart to the macOS daemon's `killall` step — Android
 * apps can't kill peer processes, but they can be denied a foreground window via
 * the accessibility surface. Bypasses:
 *   - User can disable the service in Settings (defeats it entirely; we surface
 *     this in the UI as a status indicator, but can't programmatically prevent it
 *     without Device Owner provisioning).
 *   - User can hold an allowlisted app open (we keep allowlist tight to system
 *     surfaces + the dialer for emergency calls).
 *
 * The schedule is read from a cached [StateFlow] that this service subscribes to
 * once at [onServiceConnected] — DataStore reads on every accessibility event
 * would tank UI latency.
 */
class AppBlockerService : AccessibilityService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val cachedSchedule = MutableStateFlow(Schedule())
    private val cachedFocus = MutableStateFlow(FocusSession())

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.i(TAG, "AccessibilityService connected; subscribing to schedule + focus")
        scope.launch {
            ScheduleStore(applicationContext).schedule.collect { cachedSchedule.value = it }
        }
        scope.launch {
            FocusStore(applicationContext).session.collect { cachedFocus.value = it }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString() ?: return

        val sched = cachedSchedule.value
        val focus = cachedFocus.value
        // Union the hardcoded defaults with the user's additions. Defaults are
        // never subtractable — see Schedule.userAllowlist doc.
        val effectiveAllowlist = HARDCODED_ALLOWLIST + sched.userAllowlist
        if (pkg in effectiveAllowlist) return

        val curfewing = if (sched.active) {
            val zone = runCatching { ZoneId.of(sched.timezone.ifBlank { "UTC" }) }.getOrDefault(ZoneId.of("UTC"))
            val now = LocalDateTime.now(zone)
            val dayKey = now.dayOfWeek.name.lowercase()
            val hhmm = "%02d:%02d".format(now.hour, now.minute)
            sched.isCurfewActive(dayKey, hhmm)
        } else false

        val focusing = focus.active && !focus.isElapsed()

        if ((curfewing || focusing) && !sched.enforcementPaused) {
            Log.i(TAG, "blocking $pkg (curfew=$curfewing, focus=$focusing)")
            performGlobalAction(GLOBAL_ACTION_HOME)
        }
    }

    override fun onInterrupt() {
        // No long-running work in onAccessibilityEvent — nothing to interrupt.
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "NightOwlAppBlocker"

        /**
         * Hardcoded defaults — packages exempt from blocking during curfew + focus.
         *
         * Includes:
         *   - NightOwl itself (so the user can still see status + grant perms).
         *   - System UI / Android (notification shade, status bar, home screen).
         *   - Settings (so the user can still grant device admin / accessibility,
         *     and so the friend-mediated emergency cooldown UX stays reachable).
         *   - Dialer packages (911 / equivalent emergency calls). Multiple package
         *     names because OEMs vary — Google, AOSP, Samsung.
         *
         * **A3:** users can extend this set via [Schedule.userAllowlist] in the UI.
         * Their additions are union'd with this list at the event-dispatch site —
         * they can ADD but cannot SUBTRACT defaults (the safety-critical ones).
         */
        val HARDCODED_ALLOWLIST: Set<String> = setOf(
            "com.nightowl",
            "com.android.systemui",
            "android",
            "com.android.settings",
            "com.android.phone",
            "com.android.dialer",
            "com.google.android.dialer",
            "com.samsung.android.dialer",
            "com.android.incallui",
            "com.google.android.apps.nexuslauncher", // Pixel launcher — needed so HOME bounce-back lands somewhere visible
            "com.google.android.googlequicksearchbox",
            "com.sec.android.app.launcher", // Samsung launcher
        )

        /** True iff the user has enabled this service under Settings → Accessibility. */
        fun isEnabled(ctx: Context): Boolean {
            val enabled = Settings.Secure.getString(
                ctx.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
            ) ?: return false
            val flag = ComponentName(ctx, AppBlockerService::class.java).flattenToString()
            return enabled.split(':').any { it.equals(flag, ignoreCase = true) }
        }

        /** Open the Settings → Accessibility list. The user has to enable NightOwl manually. */
        fun openSettings(ctx: Context) {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(intent)
        }
    }
}
