package com.nightowl

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * Foreground service that ticks every [TICK_INTERVAL_MS], reads the current
 * schedule, and if curfew is active calls [DevicePolicyManager.lockNow].
 *
 * This is the Android equivalent of the macOS launchd plist + the Windows
 * Task Scheduler. Unlike those, it CANNOT shut the device down — Android user
 * apps don't have that capability. Curfew enforcement = repeated lockNow().
 *
 * Wakeup behavior: Android Doze + battery optimization may delay our ticks
 * past 60s on idle devices. The user has to whitelist NightOwl under
 * Settings → Battery → Battery optimization for reliable enforcement. This
 * is documented in [packages/android/README.md].
 */
class EnforcementService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var tickJob: Job? = null
    private var pollJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIF_ID, buildNotification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (tickJob == null) {
            tickJob = scope.launch { tickLoop() }
        }
        if (pollJob == null) {
            pollJob = scope.launch { pollLoop() }
        }
        return START_STICKY
    }

    private suspend fun pollLoop() {
        val identity = Identity.loadOrCreate(applicationContext)
        val client = BotClient(identity)
        val store = ScheduleStore(applicationContext)
        PollLoop(client, store).runForever()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private suspend fun tickLoop() {
        val store = ScheduleStore(applicationContext)
        val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val adminComponent = ComponentName(applicationContext, NightOwlDeviceAdminReceiver::class.java)

        while (true) {
            val sched = store.schedule.first()
            if (sched.active && dpm.isAdminActive(adminComponent)) {
                val now = LocalDateTime.now(ZoneId.of(sched.timezone.ifBlank { "UTC" }))
                val dayKey = now.dayOfWeek.name.lowercase()
                val hhmm = "%02d:%02d".format(now.hour, now.minute)
                if (sched.isCurfewActive(dayKey, hhmm)) {
                    runCatching { dpm.lockNow() }
                }
            }
            delay(TICK_INTERVAL_MS)
        }
    }

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
        private const val CHANNEL_ID = "nightowl_enforcement"
        private const val NOTIF_ID = 1
        private const val TICK_INTERVAL_MS = 60_000L

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
