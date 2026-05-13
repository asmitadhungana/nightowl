package com.nightowl

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.widget.Toast

/**
 * Receives DeviceAdmin lifecycle callbacks. Required for the app to be allowed to
 * call [android.app.admin.DevicePolicyManager.lockNow], which is how curfew
 * enforcement actually does anything on Android.
 *
 * The user must explicitly grant DeviceAdmin via Settings → Security → Device
 * admin apps OR via [android.app.admin.DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN].
 *
 * DeviceAdmin can be revoked by the user at any time. The Friend Lock asymmetry
 * (locker holds the password, user can't talk themselves out at 2am) is the
 * intended bypass-resistance; OS-level tamper-resistance is weaker here than on
 * macOS root or Windows Task Scheduler.
 */
class NightOwlDeviceAdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        Toast.makeText(context, "NightOwl device admin enabled. Curfew enforcement is now armed.", Toast.LENGTH_LONG).show()
    }

    override fun onDisabled(context: Context, intent: Intent) {
        Toast.makeText(context, "NightOwl device admin disabled. Curfew can no longer lock the screen.", Toast.LENGTH_LONG).show()
    }
}
