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
    private val cached = MutableStateFlow(Schedule())

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.i(TAG, "AccessibilityService connected; subscribing to schedule")
        scope.launch {
            ScheduleStore(applicationContext).schedule.collect { cached.value = it }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString() ?: return
        if (pkg in ALLOWLIST) return

        val sched = cached.value
        if (!sched.active) return
        val zone = runCatching { ZoneId.of(sched.timezone.ifBlank { "UTC" }) }.getOrDefault(ZoneId.of("UTC"))
        val now = LocalDateTime.now(zone)
        val dayKey = now.dayOfWeek.name.lowercase()
        val hhmm = "%02d:%02d".format(now.hour, now.minute)
        if (sched.isCurfewActive(dayKey, hhmm)) {
            Log.i(TAG, "blocking $pkg during curfew $dayKey $hhmm")
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
         * Packages exempt from blocking during curfew.
         *
         * Includes:
         *   - NightOwl itself (so the user can still see status + grant perms).
         *   - System UI / Android (notification shade, status bar, home screen).
         *   - Settings (so the user can still grant device admin / accessibility,
         *     and so the friend-mediated emergency cooldown UX in A3 stays reachable).
         *   - Dialer packages (911 / equivalent emergency calls). Multiple package
         *     names because OEMs vary — Google, AOSP, Samsung.
         *
         * This list is intentionally tight; widen it via a future user-managed
         * allowlist screen, not by hardcoding more here.
         */
        private val ALLOWLIST = setOf(
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
