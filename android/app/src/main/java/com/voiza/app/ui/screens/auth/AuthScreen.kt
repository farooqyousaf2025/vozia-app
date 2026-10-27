package com.voiza.app.ui.screens.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.VoizaAccentGradient
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.viewmodel.AuthViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * OTP login: country code + phone -> 6-digit code (+ optional username on
 * first login). When the backend returns `devCode` (dev SMS mode) the code
 * field auto-fills and a hint chip tells the reviewer what happened.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AuthScreen(
    onLoggedIn: () -> Unit,
    viewModel: AuthViewModel = viewModel(
        factory = voizaViewModelFactory { AuthViewModel() },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    // Successful verification -> leave the auth graph (side effect, not composition).
    LaunchedEffect(state.step) {
        if (state.step == AuthViewModel.AuthUiState.Step.LOGGED_IN) {
            onLoggedIn()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(
                        androidx.compose.ui.graphics.Color(0xFF1A1040),
                        androidx.compose.ui.graphics.Color(0xFF0B0A1F),
                    )
                )
            )
            .imePadding(),
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 24.dp, vertical = 32.dp),
        ) {
            Spacer(Modifier.height(36.dp))

            // Wordmark
            Text(
                text = "Voiza",
                fontSize = 44.sp,
                fontWeight = FontWeight.Black,
                modifier = Modifier
                    .clip(RoundedCornerShape(12.dp))
                    .background(VoizaAccentGradient)
                    .padding(horizontal = 6.dp, vertical = 2.dp),
                color = OnDarkHigh,
            )
            Spacer(Modifier.height(6.dp))
            Text("Voice rooms. Gifts. Nights.", color = OnDarkMedium, fontSize = 13.sp)

            Spacer(Modifier.height(40.dp))

            when (state.step) {
                AuthViewModel.AuthUiState.Step.PHONE -> PhoneStep(viewModel, state)
                AuthViewModel.AuthUiState.Step.CODE -> CodeStep(viewModel, state)
                AuthViewModel.AuthUiState.Step.LOGGED_IN -> Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier.fillMaxSize(),
                ) { LoadingProgress() }
            }

            Spacer(Modifier.weight(1f))

            Text(
                text = "Demo build — OTP codes are delivered in-app",
                color = OnDarkMedium.copy(alpha = 0.6f),
                fontSize = 11.sp,
            )
        }

        if (state.loading && state.step != AuthViewModel.AuthUiState.Step.LOGGED_IN) {
            Box(
                contentAlignment = Alignment.BottomCenter,
                modifier = Modifier.fillMaxSize(),
            ) {
                LoadingProgress(modifier = Modifier.padding(bottom = 28.dp), size = 28.dp)
            }
        }
    }
}

@Composable
private fun PhoneStep(vm: AuthViewModel, state: AuthViewModel.AuthUiState) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Enter your phone", color = OnDarkHigh, fontSize = 20.sp, fontWeight = FontWeight.Bold)

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(
                value = state.countryCode,
                onValueChange = vm::onCountryCodeChange,
                label = { Text("Code", fontSize = 12.sp) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                colors = fieldColors(),
                modifier = Modifier.width(92.dp),
            )
            OutlinedTextField(
                value = state.phone,
                onValueChange = vm::onPhoneChange,
                label = { Text("Phone number", fontSize = 13.sp) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                colors = fieldColors(),
                modifier = Modifier.weight(1f),
            )
        }

        state.error?.let { ErrorLine(it) }

        VoizaButton(
            text = "Send code",
            onClick = vm::requestOtp,
            enabled = !state.loading && state.phone.isNotEmpty(),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun CodeStep(vm: AuthViewModel, state: AuthViewModel.AuthUiState) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Verification code", color = OnDarkHigh, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text(
            text = "Sent to ${state.countryCode}${state.phone}",
            color = OnDarkMedium,
            fontSize = 13.sp,
        )

        // Dev-mode auto-filled code hint for reviewers.
        state.devCode?.let { dev ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .background(VoizaSurfaceHigh)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(RoundedCornerShape(50))
                        .background(Cyan),
                    content = {},
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = "Dev mode: code auto-filled ($dev)",
                    color = OnDarkMedium,
                    fontSize = 12.sp,
                )
            }
        }

        OutlinedTextField(
            value = state.code,
            onValueChange = vm::onCodeChange,
            label = { Text("6-digit code", fontSize = 13.sp) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            colors = fieldColors(),
        )

        OutlinedTextField(
            value = state.username,
            onValueChange = vm::onUsernameChange,
            label = { Text("Username (first login only, optional)", fontSize = 12.sp) },
            singleLine = true,
            colors = fieldColors(),
        )

        state.error?.let { ErrorLine(it) }

        VoizaButton(
            text = "Enter Voiza",
            onClick = vm::verifyOtp,
            enabled = !state.loading && state.code.length == 6,
            gradient = VoizaAccentGradient,
            modifier = Modifier.fillMaxWidth(),
        )
        VoizaButton(
            text = "Change phone number",
            onClick = vm::backToPhone,
            enabled = !state.loading,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun ErrorLine(message: String) {
    Text(
        text = message,
        color = DangerRed,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Fuchsia,
    unfocusedBorderColor = androidx.compose.ui.graphics.Color(0xFF3D3670),
    focusedLabelColor = Fuchsia,
    unfocusedLabelColor = OnDarkMedium,
    cursorColor = Cyan,
    focusedTextColor = OnDarkHigh,
    unfocusedTextColor = OnDarkHigh,
)
