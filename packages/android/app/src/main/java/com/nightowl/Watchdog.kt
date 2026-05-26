package com.nightowl

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Self-healing watchdog for [EnforcementService].
 *
 * The problem (seen on MIUI metal-testing): aggressive OEMs kill the foreground
 * service while the phone is idle, and `START_STICKY` isn't honored — so the
 * curfew silently stops enforcing until someone re-arms by hand. A schedule lock
 * that needs manual re-arming isn't a real lock.
 *
 * The fix: an `AlarmManager` alarm. Alarms are held by the system's
 * AlarmManagerService, NOT the app process, so they keep firing even after the OS
 * kills NightOwl. Each tick ([WatchdogReceiver]) restarts the service if it's down
 * and reschedules the next tick — enforcement re-arms itself within one interval.
 *
 * `setAndAllowWhileIdle` is used deliberately: it fires through Doze, needs no
 * `SCHEDULE_EXACT_ALARM` permission, and grants the alarm-fired
 * foreground-service-start exemption on Android 12+.
 */
object Watchdog {
    private const val TAG = "NightOwlWatchdog"
    private const val REQUEST_CODE = 4711
    const val ACTION_TICK = "com.nightowl.WATCHDOG_TICK"

    /** ~15 min — the practical floor for while-idle alarms (Doze rate-limits them). */
    const val INTERVAL_MS = 15 * 60 * 1000L

    /** Schedule (or reschedule) the next watchdog tick. Idempotent — uses a fixed PendingIntent. */
    fun schedule(ctx: Context) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val triggerAt = System.currentTimeMillis() + INTERVAL_MS
        runCatching {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent(ctx))
            Log.i(TAG, "watchdog scheduled +${INTERVAL_MS / 1000}s")
        }.onFailure { Log.w(TAG, "failed to schedule watchdog: ${it.message}") }
    }

    private fun pendingIntent(ctx: Context): PendingIntent {
        val intent = Intent(ctx.applicationContext, WatchdogReceiver::class.java).setAction(ACTION_TICK)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags = flags or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(ctx.applicationContext, REQUEST_CODE, intent, flags)
    }
}
