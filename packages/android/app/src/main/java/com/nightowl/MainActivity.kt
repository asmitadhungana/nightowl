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
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            NightOwlTheme {
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
        NightOwlHeader()
        HeroStatusBanner(state = state)
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
private fun NightOwlHeader() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("🦉", style = MaterialTheme.typography.headlineMedium)
        Text(
            "NightOwl",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onBackground,
        )
    }
}

/** Big, gradient, at-a-glance state: armed badge + curfew window + live countdown. */
@Composable
private fun HeroStatusBanner(state: HomeState) {
    val armed by EnforcementService.armed.collectAsState()
    val paused = state.savedSchedule.enforcementPaused
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            nowMs = System.currentTimeMillis()
        }
    }
    val curfew = remember(state.savedSchedule, nowMs) { computeCurfewView(state.savedSchedule, nowMs) }

    val badgeText: String
    val badgeColor: Color
    when {
        paused -> { badgeText = "⏸  PAUSED BY LOCKER"; badgeColor = NightOwlPaused }
        armed -> { badgeText = "●  ARMED"; badgeColor = NightOwlArmed }
        else -> { badgeText = "●  NOT ARMED"; badgeColor = NightOwlAlert }
    }
    val headline = when {
        paused -> "Curfew paused"
        curfew.curfewingNow -> "Locked down"
        state.savedSchedule.active -> "Curfew armed"
        else -> "No curfew yet"
    }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(NightOwlHeroGradient)
            .padding(20.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(badgeText, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold, color = badgeColor)
            Text(headline, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold, color = Color.White)
            Text(curfew.windowLabel, style = MaterialTheme.typography.bodyMedium, color = Color(0xFFE3DBFB))
            curfew.countdown?.let {
                Text(it, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Medium, color = Color.White)
            }
            if (state.savedSchedule.active && state.savedSchedule.lockEndDate != null) {
                val by = state.friendName?.let { " · held by $it" } ?: ""
                Text(
                    "Locked in until ${state.savedSchedule.lockEndDate!!.take(10)}$by",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFFCFC4F2),
                )
            }
        }
    }
}

private data class CurfewView(val curfewingNow: Boolean, val windowLabel: String, val countdown: String?)

/** Curfew state for the hero, evaluated in the DEVICE-LOCAL zone (see A07 fix). */
private fun computeCurfewView(s: Schedule, nowMs: Long): CurfewView {
    if (!s.active) return CurfewView(false, "Set a schedule and lock it in to begin.", null)
    val now = java.time.ZonedDateTime.ofInstant(java.time.Instant.ofEpochMilli(nowMs), java.time.ZoneId.systemDefault())
    val dayKey = now.dayOfWeek.name.lowercase()
    val today = s.days[dayKey]
    val curfewing = s.isCurfewActive(dayKey, "%02d:%02d".format(now.hour, now.minute))
    val window = if (today?.curfewStart != null && today.curfewEnd != null) "${today.curfewStart}–${today.curfewEnd}" else null
    if (curfewing) {
        return CurfewView(true, today?.curfewEnd?.let { "Unlocks at $it" } ?: "Curfew active now", null)
    }
    val countdown = today?.curfewStart?.let { st ->
        val parts = st.split(":")
        val h = parts.getOrNull(0)?.toIntOrNull()
        val m = parts.getOrNull(1)?.toIntOrNull()
        if (h != null && m != null) {
            var target = now.withHour(h).withMinute(m).withSecond(0).withNano(0)
            if (!target.isAfter(now)) target = target.plusDays(1)
            val mins = java.time.Duration.between(now, target).toMinutes()
            "Curfew in ${mins / 60}h ${mins % 60}m"
        } else null
    }
    return CurfewView(false, window?.let { "Nightly curfew $it" } ?: "Curfew armed", countdown)
}

@Composable
private fun PermissionsCard(state: HomeState, onGrantDeviceAdmin: () -> Unit, onGrantAccessibility: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionHeader("🔐", "Permissions")
            PermissionRow("Device admin", state.deviceAdminActive, onGrantDeviceAdmin)
            PermissionRow("App blocker (Accessibility)", state.accessibilityActive, onGrantAccessibility)
            if (!state.accessibilityActive) {
                Text(
                    "Without the app blocker, curfew only re-locks the screen — apps still open between locks.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun PermissionRow(label: String, granted: Boolean, onGrant: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = MaterialTheme.typography.bodyLarge)
        if (granted) {
            StatusPill("✓ Granted", NightOwlArmed)
        } else {
            Button(onClick = onGrant, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 6.dp)) {
                Text("Grant")
            }
        }
    }
}

@Composable
private fun PairingCard(state: HomeState, onEnroll: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionHeader("👥", "Friend Lock")
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
            // Only offer enrollment before there's a pairing — a dead/disabled button
            // once paired just reads as clutter.
            if (state.pairCode == null && state.pairingId == null) {
                Button(onClick = onEnroll) {
                    Text("Generate pair code")
                }
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
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                SectionHeader("🛡️", "Enforcement")
                StatusPill(if (armed) "● ARMED" else "● NOT ARMED", if (armed) NightOwlArmed else NightOwlAlert)
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
