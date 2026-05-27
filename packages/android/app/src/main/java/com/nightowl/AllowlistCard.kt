package com.nightowl

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp

/**
 * App-blocker allowlist editor. Lets the user add packages to the union'd allowlist
 * on top of the hardcoded defaults. Defaults cannot be removed (safety-critical:
 * dialer, system UI, Settings, NightOwl itself, launcher).
 */
@Composable
fun AllowlistCard(
    state: HomeState,
    onInputChange: (String) -> Unit,
    onAdd: () -> Unit,
    onRemove: (String) -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionHeader("📋", "App blocker allowlist")
            Text(
                "Apps you can still open during curfew + focus. NightOwl, the dialer, Settings, system UI, " +
                    "and launchers are always allowed and not shown.",
                style = MaterialTheme.typography.bodySmall,
            )

            // List user-added entries.
            val list = state.savedSchedule.userAllowlist
            if (list.isEmpty()) {
                Text("(no user-added packages yet)", style = MaterialTheme.typography.bodySmall)
            } else {
                for (pkg in list) {
                    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        Text(pkg, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(220.dp))
                        TextButton(onClick = { onRemove(pkg) }) { Text("Remove") }
                    }
                }
            }

            // Add row.
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = state.allowlistInput,
                    onValueChange = onInputChange,
                    label = { Text("Package name (e.g. com.spotify.music)") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None),
                    modifier = Modifier.width(280.dp),
                )
                Button(onClick = onAdd) { Text("Add") }
            }

            Text(
                "Tip: open Settings → Apps → <app> to find the exact package name.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}
