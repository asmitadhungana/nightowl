package com.nightowl

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Fires on each [Watchdog] alarm. If the enforcement service isn't running
 * (e.g. MIUI killed the process), restart it; then reschedule the next tick so
 * the watchdog keeps running across process deaths.
 *
 * Kept synchronous and minimal so the foreground-service start stays inside the
 * alarm-fired exemption window on Android 12+. `EnforcementService.armed` reflects
 * whether the service is live in the current process (false after a process kill),
 * so we only restart when it's actually down.
 */
class WatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val appCtx = context.applicationContext
        if (!EnforcementService.armed.value) {
            Log.i(TAG, "watchdog: enforcement service is down — restarting it")
            runCatching { EnforcementService.start(appCtx) }
        }
        // Always reschedule so the chain survives even when the process was just
        // spun up by this very alarm.
        Watchdog.schedule(appCtx)
    }

    private companion object {
        const val TAG = "NightOwlWatchdog"
    }
}
