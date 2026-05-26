package com.nightowl

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                NightOwlScaffold()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // Refresh permission flags when returning from the system Settings screens.
        // The ViewModel lives across config changes so this is cheap.
        // The actual refresh fires when the schedule store re-emits; we just trigger it.
    }
}

@Composable
private fun NightOwlScaffold() {
    Scaffold { padding ->
        Home(padding)
    }
}

@Composable
private fun Home(padding: PaddingValues) {
    val ctx = LocalContext.current
    val vm: HomeViewModel = viewModel(factory = HomeViewModel.Factory(ctx.applicationContext))
    val state by vm.state.collectAsState()

    LaunchedEffect(Unit) { vm.refreshPermissionFlags() }

    val scroll = rememberScrollState()
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(padding)
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .verticalScroll(scroll),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("🦉 NightOwl Android — alpha", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Pair with your locker over Telegram, set per-day curfew, and lock it in. " +
                "During curfew the screen re-locks and non-essential apps bounce back to home.",
            style = MaterialTheme.typography.bodySmall,
        )

        StatusCard(state = state)
        PermissionsCard(state = state, onGrantDeviceAdmin = { requestDeviceAdmin(ctx) }, onGrantAccessibility = { AppBlockerService.openSettings(ctx) })
        PairingCard(state = state, onEnroll = { vm.enroll() })
        ScheduleEditor(
            state = state,
            onSetEnabled = vm::setDayEnabled,
            onSetStart = vm::setDayStart,
            onSetEnd = vm::setDayEnd,
            onCopyMonday = vm::copyMondayToAll,
            onPreset = vm::applyPreset,
            onSetLockDays = vm::setLockDays,
            onSave = vm::saveSchedule,
            onActivate = vm::activateSchedule,
        )
        UninstallCard(
            state = state,
            onRequestUninstall = vm::requestUninstall,
            onCancelPending = vm::cancelPendingUninstallRequest,
            onStartCooldown = vm::startEmergencyCooldown,
            onSoftUninstall = vm::softUninstall,
        )
        FocusCard(
            state = state,
            onStart = vm::startFocus,
            onRequestRelease = vm::requestFocusRelease,
            onCancelPending = vm::cancelPendingFocusRelease,
            onEndEarly = vm::endFocusEarly,
        )
        if (state.accessibilityActive) {
            AllowlistCard(
                state = state,
                onInputChange = vm::setAllowlistInput,
                onAdd = vm::addAllowlistEntry,
                onRemove = vm::removeAllowlistEntry,
            )
        }
        EnforcementCard(onArm = { EnforcementService.start(ctx) })

        if (state.lastError != null || state.lastMessage != null) {
            MessageCard(error = state.lastError, message = state.lastMessage, onDismiss = vm::clearMessage)
        }
    }
}

@Composable
private fun StatusCard(state: HomeState) {
    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Status", style = MaterialTheme.typography.titleMedium)
            Text("Pairing phase: ${state.phase?.name ?: "(not enrolled)"}")
            state.friendName?.let { Text("Locker: $it") }
            Text("Lock active: ${if (state.savedSchedule.active) "YES until ${state.savedSchedule.lockEndDate}" else "no"}")
            if (state.savedSchedule.enforcementPaused) {
                Text(
                    "⏸ Paused by your locker — curfew won't lock until they /resume.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

@Composable
private fun PermissionsCard(state: HomeState, onGrantDeviceAdmin: () -> Unit, onGrantAccessibility: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Permissions", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Device admin: ${if (state.deviceAdminActive) "✓" else "✗"}", style = MaterialTheme.typography.bodyMedium)
                if (!state.deviceAdminActive) {
                    TextButton(onClick = onGrantDeviceAdmin) { Text("Grant") }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "App blocker (Accessibility): ${if (state.accessibilityActive) "✓" else "✗"}",
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (!state.accessibilityActive) {
                    TextButton(onClick = onGrantAccessibility) { Text("Grant") }
                }
            }
            if (!state.accessibilityActive) {
                Text(
                    "Without the app blocker, curfew only re-locks the screen — apps will still open between locks. Grant accessibility to block app launches during curfew.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun PairingCard(state: HomeState, onEnroll: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Friend Lock", style = MaterialTheme.typography.titleMedium)
            val locker = state.friendName ?: "your friend"
            when {
                state.phase == DelegationPhase.active ->
                    Text(
                        "✓ Friend Lock active — locked by $locker, who holds the password. " +
                            "Uninstall needs their approval (or the 72h cooldown).",
                        style = MaterialTheme.typography.bodySmall,
                    )
                state.phase == DelegationPhase.paired || state.phase == DelegationPhase.awaiting_password ->
                    Text(
                        "Paired with $locker — waiting for them to set the password (/setpassword to the bot).",
                        style = MaterialTheme.typography.bodySmall,
                    )
                state.phase == DelegationPhase.revoked ->
                    Text(
                        "$locker stepped away (revoked). The lock continues; the 72h emergency cooldown is the only early exit.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                state.pairCode != null -> {
                    Text("Pair code: ${state.pairCode}", style = MaterialTheme.typography.headlineSmall)
                    Text(
                        "Send this to your locker. They DM the bot: /pair ${state.pairCode} then /setpassword <pw>.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                state.pairingId != null ->
                    Text("Enrolled — waiting for your friend to /pair with your code.", style = MaterialTheme.typography.bodySmall)
                else ->
                    Text("Not enrolled yet. Generate a pair code to begin.", style = MaterialTheme.typography.bodySmall)
            }
            Button(onClick = onEnroll, enabled = state.pairCode == null && state.pairingId == null) {
                Text("Generate pair code")
            }
        }
    }
}

@Composable
private fun EnforcementCard(onArm: () -> Unit) {
    val armed by EnforcementService.armed.collectAsState()
    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Enforcement service", style = MaterialTheme.typography.titleMedium)
                Text(
                    if (armed) "● ARMED" else "● NOT ARMED",
                    style = MaterialTheme.typography.labelLarge,
                    color = if (armed) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                )
            }
            Text(
                if (armed) {
                    "Running — curfew + focus locks will fire, and the poll loop is syncing with the bot. " +
                        "The BootReceiver re-arms it after reboot."
                } else {
                    "⚠ Not running — curfew won't enforce and pairing won't sync. Tap to arm " +
                        "(also re-arm after an app update)."
                },
                style = MaterialTheme.typography.bodySmall,
            )
            if (armed) {
                OutlinedButton(onClick = onArm) { Text("Re-arm") }
            } else {
                Button(onClick = onArm) { Text("Arm enforcement service") }
            }
        }
    }
}

@Composable
private fun MessageCard(error: String?, message: String?, onDismiss: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            error?.let { Text("Error: $it", color = MaterialTheme.colorScheme.error) }
            message?.let { Text(it) }
            TextButton(onClick = onDismiss) { Text("Dismiss") }
        }
    }
}

private fun requestDeviceAdmin(ctx: Context) {
    val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
        putExtra(
            DevicePolicyManager.EXTRA_DEVICE_ADMIN,
            ComponentName(ctx, NightOwlDeviceAdminReceiver::class.java),
        )
        putExtra(
            DevicePolicyManager.EXTRA_ADD_EXPLANATION,
            "NightOwl needs device admin to lock your screen during curfew hours. " +
                "Your locker holds the password; uninstall is gated through them.",
        )
    }
    if (ctx !is android.app.Activity) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    ctx.startActivity(intent)
}
