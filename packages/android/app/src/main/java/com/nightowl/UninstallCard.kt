package com.nightowl

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Friend Lock uninstall card — shown only while a delegation exists. Mirrors the
 * desktop's locked-screen "Need to uninstall?" card. Buttons are gated on the
 * current `uninstallGate` verdict; non-cancellable cooldown is hard-confirmed.
 */
@Composable
fun UninstallCard(
    state: HomeState,
    onRequestUninstall: () -> Unit,
    onCancelPending: () -> Unit,
    onStartCooldown: () -> Unit,
    onSoftUninstall: () -> Unit,
) {
    // Hidden entirely when there's no delegation — the card is meaningless then.
    if (state.savedSchedule.delegation == null) return

    var showCooldownConfirm by remember { mutableStateOf(false) }

    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionHeader("🚪", "Need to uninstall?")
            Text(
                "You handed your password to ${state.friendName ?: "your friend"}. Ask them to /approve via Telegram, " +
                    "or start a 72-hour emergency cooldown that releases the lock without them.",
                style = MaterialTheme.typography.bodySmall,
            )

            // Gate-status line — shows the "Why blocked?" reason or "Approved" message.
            val gate = state.uninstallGate
            val stateText = when (gate) {
                is DelegationGate.Allowed -> "✓ Uninstall allowed: ${gate.reason}"
                is DelegationGate.Blocked -> "⛔ ${gate.reason}"
            }
            Text(stateText, style = MaterialTheme.typography.bodySmall)

            // Countdown line for an active cooldown.
            val cooldownMs = state.emergencyCooldownRemainingMs
            if (cooldownMs > 0) {
                val hours = cooldownMs / (1000 * 60 * 60)
                val minutes = (cooldownMs / (1000 * 60)) % 60
                Text("Cooldown: ${hours}h ${minutes}m remaining", style = MaterialTheme.typography.bodySmall)
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val pending = state.savedSchedule.delegation.pendingUninstallReqId
                if (pending == null) {
                    Button(
                        onClick = onRequestUninstall,
                        enabled = state.phase == DelegationPhase.active,
                    ) {
                        Text("Ask friend to release")
                    }
                } else {
                    OutlinedButton(onClick = onCancelPending) { Text("Cancel pending request") }
                }
                if (state.savedSchedule.delegation.emergencyUninstallStartedAt == null) {
                    OutlinedButton(onClick = { showCooldownConfirm = true }) {
                        Text("Start 72h cooldown")
                    }
                }
                if (state.uninstallGate is DelegationGate.Allowed) {
                    Button(onClick = onSoftUninstall) { Text("Uninstall now") }
                }
            }
        }
    }

    if (showCooldownConfirm) {
        AlertDialog(
            onDismissRequest = { showCooldownConfirm = false },
            title = { Text("Start the 72-hour cooldown?") },
            text = {
                Text(
                    "This timer **cannot be cancelled** once started. It's the safety net for when your friend " +
                        "is unreachable or refuses. Most users won't need it. After 72 hours elapse, NightOwl " +
                        "will allow uninstall without your friend's approval.",
                )
            },
            confirmButton = {
                Button(onClick = {
                    showCooldownConfirm = false
                    onStartCooldown()
                }) { Text("Yes, start it") }
            },
            dismissButton = {
                TextButton(onClick = { showCooldownConfirm = false }) { Text("No") }
            },
        )
    }
}
