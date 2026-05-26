package com.nightowl

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * Foreground service that enforces the curfew/focus lock via
 * [DevicePolicyManager.lockNow]. Two mechanisms, both needed on phones:
 *
 *  1. **Instant re-lock on unlock.** A [USER_PRESENT] receiver fires the moment
 *     the user dismisses the keyguard; if a curfew/focus is active we lockNow()
 *     immediately. On a phone a quick PIN unlock made a 60s tick feel like a
 *     non-event ("unlock, scroll for a minute") — relocking on USER_PRESENT
 *     leaves no usable window. (Metal-validated 2026-05-26: the 60s-only tick
 *     was too soft on Android.)
 *  2. **Short backup tick.** While enforcing we re-check every
 *     [ENFORCING_TICK_MS] (vs [IDLE_TICK_MS] when idle, to save battery) and
 *     lockNow() — catches cases USER_PRESENT misses (screen already on, app
 *     switches) and is the safety net if the receiver is throttled.
 *
 * Unlike macOS/Windows this CANNOT power the device off — Android user apps
 * can't. Enforcement = repeated lockNow(). Doze + battery optimization can still
 * delay ticks; the user whitelists NightOwl under Battery optimization (and, on
 * MIUI, Autostart + No-restrictions) for reliable enforcement.
 */
class EnforcementService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var tickJob: Job? = null
    private var pollJob: Job? = null

    private val store by lazy { ScheduleStore(applicationContext) }
    private val focusStore by lazy { FocusStore(applicationContext) }
    private val dpm by lazy { getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager }
    private val adminComponent by lazy { ComponentName(applicationContext, NightOwlDeviceAdminReceiver::class.java) }

    /** Re-lock the instant the keyguard is dismissed during an active curfew/focus. */
    private val unlockReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != Intent.ACTION_USER_PRESENT) return
            scope.launch {
                if (enforcingNow() && dpm.isAdminActive(adminComponent)) {
                    runCatching { dpm.lockNow() }
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIF_ID, buildNotification())
        ContextCompat.registerReceiver(
            this,
            unlockReceiver,
            IntentFilter(Intent.ACTION_USER_PRESENT),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        armed.value = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (tickJob == null) {
            tickJob = scope.launch { tickLoop() }
        }
        if (pollJob == null) {
            pollJob = scope.launch { pollLoop() }
        }
        // Kick off the self-healing watchdog so MIUI killing this service later
        // gets noticed + re-armed without the user touching anything.
        Watchdog.schedule(applicationContext)
        return START_STICKY
    }

    private suspend fun pollLoop() {
        val identity = Identity.loadOrCreate(applicationContext)
        val client = BotClient(identity)
        PollLoop(client, store, focusStore).runForever()
    }

    override fun onDestroy() {
        armed.value = false
        runCatching { unregisterReceiver(unlockReceiver) }
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private suspend fun tickLoop() {
        while (true) {
            val sched0 = store.schedule.first()
            val focus = focusStore.session.first()
            // Auto-clear an elapsed focus session so the UI reflects reality without an app re-open.
            if (focus.active && focus.isElapsed()) {
                focusStore.update { FocusSession() }
            }
            // Lock period over → deactivate so it stops enforcing and the service can stand down.
            val sched = if (sched0.isLockExpired()) {
                store.update { it.copy(active = false) }
                sched0.copy(active = false)
            } else {
                sched0
            }

            val focusing = focus.active && !focus.isElapsed()
            // Nothing left to enforce (no active lock AND no live focus) → stand down cleanly
            // instead of lingering as a zombie foreground service. Cancel the watchdog so it
            // won't resurrect us; arming again later reschedules it. NOTE: a daytime gap
            // outside the curfew window is NOT this state — sched.active is still true then.
            if (!sched.active && !focusing) {
                Watchdog.cancel(applicationContext)
                withContext(Dispatchers.Main) {
                    stopForeground(Service.STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
                return
            }

            val enforcing = !sched.enforcementPaused && (curfewActive(sched) || focusing)
            if (enforcing && dpm.isAdminActive(adminComponent)) {
                runCatching { dpm.lockNow() }
            }
            delay(if (enforcing) ENFORCING_TICK_MS else IDLE_TICK_MS)
        }
    }

    /**
     * True iff we should be locking RIGHT NOW — i.e. inside a curfew window or a
     * live focus session. Used by the instant-relock receiver. MUST be the
     * current-window check (`curfewActive`), NOT merely `sched.active` — otherwise
     * the screen re-locks on every unlock 24/7 throughout the lock period instead
     * of only during curfew hours. (Regression fixed: v0.3.6 → v0.3.7.)
     */
    private suspend fun enforcingNow(): Boolean {
        val sched = store.schedule.first()
        val focus = focusStore.session.first()
        if (sched.enforcementPaused) return false
        return curfewActive(sched) || (focus.active && !focus.isElapsed())
    }

    private fun curfewActive(sched: Schedule): Boolean {
        if (!sched.active) return false
        val now = LocalDateTime.now(zoneOf(sched.timezone))
        return sched.isCurfewActive(
            dayKey = now.dayOfWeek.name.lowercase(),
            nowHHMM = "%02d:%02d".format(now.hour, now.minute),
        )
    }

    private fun zoneOf(tz: String): ZoneId =
        runCatching { ZoneId.of(tz.ifBlank { "UTC" }) }.getOrDefault(ZoneId.of("UTC"))

    private fun buildNotification(): android.app.Notification {
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "NightOwl curfew", NotificationManager.IMPORTANCE_LOW)
            channel.description = "Background service that enforces your curfew schedule."
            mgr.createNotificationChannel(channel)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle("NightOwl is watching")
            .setContentText("Curfew enforcement is armed.")
            .setOngoing(true)
            .build()
    }

    companion object {
        /**
         * True while the service is running in this process. The UI observes this
         * to show ARMED / NOT-ARMED at a glance, so the user doesn't have to check
         * the notification shade. Resets to false if MIUI kills the process (the
         * service genuinely isn't running then) and flips back to true on re-arm.
         */
        val armed = MutableStateFlow(false)

        private const val CHANNEL_ID = "nightowl_enforcement"
        private const val NOTIF_ID = 1

        /** Re-lock cadence while a curfew/focus is active. Tight so a quick unlock
         *  leaves no usable window; the USER_PRESENT receiver handles the instant case. */
        private const val ENFORCING_TICK_MS = 5_000L

        /** Relaxed cadence when nothing is being enforced — saves battery. */
        private const val IDLE_TICK_MS = 60_000L

        fun start(ctx: Context) {
            val intent = Intent(ctx, EnforcementService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
        }
    }
}
