package com.nightowl

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

/**
 * The schedule editor — per-day rows + presets + lock-duration picker + Activate.
 *
 * Stateless w.r.t. the schedule itself; all writes route through the ViewModel
 * so the persistence model stays consistent with the bot poll loop's writes.
 */
@Composable
fun ScheduleEditor(
    state: HomeState,
    onSetEnabled: (String, Boolean) -> Unit,
    onSetStart: (String, String) -> Unit,
    onSetEnd: (String, String) -> Unit,
    onCopyMonday: () -> Unit,
    onPreset: (String) -> Unit,
    onSetLockDays: (Int) -> Unit,
    onSave: () -> Unit,
    onActivate: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            SectionHeader("🌙", "Schedule")
            Text(
                "Set a curfew for each day. Off days are blank. Overnight curfews " +
                    "(e.g. 22:00 → 06:00) wrap automatically.",
                style = MaterialTheme.typography.bodySmall,
            )

            Spacer(Modifier.height(4.dp))

            // Per-day rows.
            for (dayKey in DAY_KEYS) {
                val day = state.editorDays[dayKey] ?: DaySchedule()
                DayRow(
                    dayKey = dayKey,
                    day = day,
                    onEnabled = { onSetEnabled(dayKey, it) },
                    onStart = { onSetStart(dayKey, it) },
                    onEnd = { onSetEnd(dayKey, it) },
                )
            }

            Spacer(Modifier.height(4.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = onCopyMonday) { Text("Copy Monday to all") }
            }

            Text("Presets", style = MaterialTheme.typography.labelLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AssistChip(onClick = { onPreset("night_owl") }, label = { Text("Night Owl") })
                AssistChip(onClick = { onPreset("early_bird") }, label = { Text("Early Bird") })
                AssistChip(onClick = { onPreset("weekend_flex") }, label = { Text("Weekend Flex") })
            }

            Spacer(Modifier.height(4.dp))
            Text("Lock duration", style = MaterialTheme.typography.labelLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (days in listOf(1, 3, 7, 14, 30)) {
                    FilterChip(
                        selected = state.editorLockDays == days,
                        onClick = { onSetLockDays(days) },
                        label = { Text("${days}d") },
                    )
                }
            }
            Text(
                "Curfew uses this phone's local time · ${java.util.TimeZone.getDefault().id}",
                style = MaterialTheme.typography.bodySmall,
            )

            Spacer(Modifier.height(8.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = onSave, enabled = state.editorDirty) {
                    Text(if (state.editorDirty) "Save schedule" else "Saved")
                }
                Button(
                    onClick = onActivate,
                    enabled = !state.savedSchedule.active && !state.editorDirty,
                ) {
                    Text(if (state.savedSchedule.active) "Locked in" else "Activate")
                }
            }
        }
    }
}

@Composable
private fun DayRow(
    dayKey: String,
    day: DaySchedule,
    onEnabled: (Boolean) -> Unit,
    onStart: (String) -> Unit,
    onEnd: (String) -> Unit,
) {
    val enabled = day.curfewStart != null && day.curfewEnd != null
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
    ) {
        Text(
            dayKey.replaceFirstChar { it.uppercase() }.take(3),
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.width(40.dp),
        )
        Switch(checked = enabled, onCheckedChange = onEnabled)
        if (enabled) {
            OutlinedTextField(
                value = day.curfewStart ?: "",
                onValueChange = onStart,
                label = { Text("Start") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.width(110.dp),
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            )
            OutlinedTextField(
                value = day.curfewEnd ?: "",
                onValueChange = onEnd,
                label = { Text("End") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.width(110.dp),
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            )
        } else {
            Text("(off)", style = MaterialTheme.typography.bodySmall)
        }
    }
}
