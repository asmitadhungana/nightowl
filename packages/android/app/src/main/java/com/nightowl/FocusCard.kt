package com.nightowl

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

/**
 * Focus Mode card — start a session, or, when active, manage the running session.
 * Mirrors desktop M7 Friend Focus UX:
 *   - solo focus is uncancellable until elapsed
 *   - friend-gated focus has an "Ask friend to release" button
 *   - friend-gated requires an active delegation (gated in the ViewModel)
 */
@Composable
fun FocusCard(
    state: HomeState,
    onStart: (Int, Boolean) -> Unit,
    onRequestRelease: () -> Unit,
    onCancelPending: () -> Unit,
    onEndEarly: () -> Unit,
) {
    val focus = state.focus
    val active = focus.active && !focus.isElapsed()

    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Focus Mode", style = MaterialTheme.typography.titleMedium)

            if (!active) {
                FocusStartUi(canFriendGate = state.phase == DelegationPhase.active, onStart = onStart)
            } else {
                FocusActiveUi(
                    state = state,
                    onRequestRelease = onRequestRelease,
                    onCancelPending = onCancelPending,
                    onEndEarly = onEndEarly,
                )
            }
        }
    }
}

@Composable
private fun FocusStartUi(canFriendGate: Boolean, onStart: (Int, Boolean) -> Unit) {
    var selectedMin by remember { mutableStateOf(25) }
    var customText by remember { mutableStateOf("") }
    var friendGated by remember { mutableStateOf(false) }

    Text(
        "A short, hard curfew. During focus the screen re-locks the moment you unlock " +
            "(and every few seconds after), and apps bounce back to home if accessibility is granted.",
        style = MaterialTheme.typography.bodySmall,
    )

    Text("Duration", style = MaterialTheme.typography.labelLarge)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (min in listOf(15, 25, 45, 60, 90)) {
            FilterChip(
                selected = selectedMin == min && customText.isEmpty(),
                onClick = { selectedMin = min; customText = "" },
                label = { Text("${min}m") },
            )
        }
    }

    // Manual timer — any value 1..480 min. Handy for quick tests and odd durations.
    // Capped at 8h because solo focus is uncancellable: a runaway typo shouldn't
    // be able to lock the device for days.
    val customMin = customText.toIntOrNull()
    val customValid = customMin != null && customMin in 1..480
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedTextField(
            value = customText,
            onValueChange = { customText = it.filter { c -> c.isDigit() }.take(3) },
            label = { Text("Custom min") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.width(140.dp),
        )
        Button(
            enabled = customValid,
            onClick = { customMin?.let { onStart(it, friendGated && canFriendGate) } },
        ) { Text("Start custom") }
    }
    if (customText.isNotEmpty() && !customValid) {
        Text(
            "Enter 1–480 minutes.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
        )
    }

    if (canFriendGate) {
        Row {
            Checkbox(checked = friendGated, onCheckedChange = { friendGated = it })
            Text(
                "Friend-gated — let your friend release early via Telegram. Otherwise, " +
                    "the session is uncancellable until time elapses.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }

    Button(onClick = { onStart(selectedMin, friendGated && canFriendGate) }) {
        Text("Start ${selectedMin}m focus")
    }
}

@Composable
private fun FocusActiveUi(
    state: HomeState,
    onRequestRelease: () -> Unit,
    onCancelPending: () -> Unit,
    onEndEarly: () -> Unit,
) {
    val focus = state.focus
    val remaining = focus.remainingMs()
    val mins = remaining / (1000 * 60)
    val secs = (remaining / 1000) % 60
    Text("Focus active — ${mins}m ${secs}s remaining", style = MaterialTheme.typography.bodyMedium)
    if (focus.friendGated) {
        val gate = state.focusReleaseGate
        val gateText = when (gate) {
            is DelegationGate.Allowed -> "✓ Early release allowed: ${gate.reason}"
            is DelegationGate.Blocked -> "⛔ ${gate.reason}"
        }
        Text(gateText, style = MaterialTheme.typography.bodySmall)

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (focus.pendingReleaseReqId == null) {
                Button(onClick = onRequestRelease) { Text("Ask friend to release") }
            } else {
                OutlinedButton(onClick = onCancelPending) { Text("Cancel pending request") }
            }
            if (state.focusReleaseGate is DelegationGate.Allowed) {
                Button(onClick = onEndEarly) { Text("End focus now") }
            }
        }
    } else {
        Text("Solo focus — uncancellable until elapsed.", style = MaterialTheme.typography.bodySmall)
    }
}
