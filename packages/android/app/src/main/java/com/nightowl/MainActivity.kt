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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                NightOwlScaffold()
            }
        }
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

    LaunchedEffect(Unit) { vm.refresh() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(padding)
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("🦉 NightOwl Android — alpha", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Tracer-bullet build. Pair with your locker over Telegram, set a schedule, " +
                "and during curfew the screen locks. See packages/android/README.md for the " +
                "honest list of what's wired and what's stubbed.",
            style = MaterialTheme.typography.bodyMedium,
        )

        Spacer(Modifier.height(8.dp))
        Text("Status", style = MaterialTheme.typography.titleMedium)
        Text("Pair code: ${state.pairCode ?: "(not enrolled)"}")
        Text("Pairing ID: ${state.pairingId ?: "(not enrolled)"}")
        Text("Device admin: ${if (state.deviceAdminActive) "active" else "INACTIVE — tap below to grant"}")
        Text("Enforcement service: ${if (state.serviceRunning) "armed" else "off"}")

        Spacer(Modifier.height(8.dp))

        if (!state.deviceAdminActive) {
            Button(onClick = { requestDeviceAdmin(ctx) }) {
                Text("Grant device admin")
            }
        }

        Button(onClick = { vm.enroll() }, enabled = state.pairCode == null) {
            Text(if (state.pairCode == null) "Generate pair code" else "Enrolled — pair code shown above")
        }

        Button(onClick = { EnforcementService.start(ctx) }) {
            Text("Arm enforcement service")
        }

        state.lastError?.let { err ->
            Spacer(Modifier.height(8.dp))
            Text("Last error: $err", color = MaterialTheme.colorScheme.error)
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

data class HomeState(
    val pairCode: String? = null,
    val pairingId: String? = null,
    val deviceAdminActive: Boolean = false,
    val serviceRunning: Boolean = false,
    val lastError: String? = null,
)

class HomeViewModel(private val appCtx: Context) : ViewModel() {

    private val identity = Identity.loadOrCreate(appCtx)
    private val store = ScheduleStore(appCtx)
    private val client = BotClient(identity)

    private val _state = MutableStateFlow(HomeState())
    val state: StateFlow<HomeState> = _state.asStateFlow()

    fun refresh() {
        viewModelScope.launch {
            val sched = store.current()
            val dpm = appCtx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            val admin = ComponentName(appCtx, NightOwlDeviceAdminReceiver::class.java)
            _state.value = _state.value.copy(
                pairingId = sched.delegation?.pairingId,
                deviceAdminActive = dpm.isAdminActive(admin),
            )
        }
    }

    fun enroll() {
        viewModelScope.launch {
            try {
                val resp = client.enroll()
                store.update { it.copy(delegation = DelegationState(pairingId = resp.pairingId)) }
                _state.value = _state.value.copy(
                    pairCode = resp.pairCode,
                    pairingId = resp.pairingId,
                    lastError = null,
                )
            } catch (e: Exception) {
                _state.value = _state.value.copy(lastError = e.message ?: e::class.simpleName)
            }
        }
    }

    class Factory(private val appCtx: Context) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = HomeViewModel(appCtx) as T
    }
}
