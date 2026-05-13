package com.nightowl

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Re-arms [EnforcementService] after device boot so the user can't dodge curfew by rebooting. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            EnforcementService.start(context.applicationContext)
        }
    }
}
