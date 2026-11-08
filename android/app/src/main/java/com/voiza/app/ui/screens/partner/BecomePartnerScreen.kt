package com.voiza.app.ui.screens.partner

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Work
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.ApplicationStatus
import com.voiza.app.domain.model.PartnerRoleEntry
import com.voiza.app.ui.components.EmptyState
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.components.VoizaSecondaryButton
import com.voiza.app.ui.theme.DiamondGold
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.VoizaSurface
import com.voiza.app.ui.theme.VoizaSurfaceVariant
import com.voiza.app.viewmodel.PartnerViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * Become a Partner: the four roles a member can ask for.
 *
 * This screen grants nothing. Every row here is a request that goes to an operator, and the state it
 * shows is that request's — the server's `granted` flag, not this build's reading of
 * `users.user_type`, which the room service has always written for anybody who opened a room.
 *
 * The role travels as the server's own constant, so a fifth application type added in the backend
 * arrives here as another card with the same buttons rather than as something this APK cannot name.
 */
@Composable
fun BecomePartnerScreen(
    onBack: () -> Unit,
    onOpenRole: (String) -> Unit,
    onOpenMyApplications: () -> Unit,
    viewModel: PartnerViewModel = viewModel(
        factory = voizaViewModelFactory { PartnerViewModel() },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    // A decision can land while the member is somewhere else; the hub re-reads when it comes back.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { viewModel.refresh() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
    ) {
        PartnerHeader(
            title = "Become a Partner",
            subtitle = "Apply to host, run an agency, sell diamonds or grow a territory.",
            onBack = onBack,
        )
        Spacer(Modifier.height(14.dp))

        if (state.loading && state.catalogue == null) {
            LoadingProgress(overlay = false)
            return@Column
        }
        if (state.isGuest) {
            EmptyState(
                icon = Icons.Default.Work,
                title = "Sign in to apply",
                subtitle = "An application belongs to an account, so it has to be filed from one.",
                action = { VoizaSecondaryButton(text = "Back", onClick = onBack) },
            )
            return@Column
        }

        state.error?.let { PartnerError(it) }

        Text(
            text = "Applying sends the form to an operator. Nothing changes on your account until they " +
                "approve it, and an approval is recorded against your account rather than set here.",
            color = OnDarkMedium,
            fontSize = 12.sp,
        )
        Spacer(Modifier.height(14.dp))

        // Above the cards, not under them: the four role cards together are taller than the screen,
        // so a member who came back to see whether an operator had decided anything had to scroll
        // past everything they had not applied for first.
        VoizaSecondaryButton(
            text = "My applications",
            onClick = onOpenMyApplications,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(14.dp))

        state.entries.forEach { entry ->
            RoleCard(entry = entry, onOpenRole = onOpenRole)
            Spacer(Modifier.height(12.dp))
        }

        Spacer(Modifier.height(30.dp))
    }
}

@Composable
private fun RoleCard(entry: PartnerRoleEntry, onOpenRole: (String) -> Unit) {
    val form = entry.form
    val application = entry.openApplication
    val (statusLabel, statusColor) = entryPresentation(entry.granted, application)

    VoizaCard(
        backgroundColor = VoizaSurface,
        modifier = Modifier
            .fillMaxWidth()
            // An approved role has no form to open from here; its history is in My applications.
            .clickable(enabled = !entry.granted) { onOpenRole(form.role) },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Work, contentDescription = null, tint = DiamondGold, modifier = Modifier.width(20.dp))
            Spacer(Modifier.width(8.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(form.title.ifBlank { form.role }, color = OnDarkHigh, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Text(form.blurb, color = OnDarkMedium, fontSize = 12.sp)
            }
            Spacer(Modifier.width(8.dp))
            StatusPill(label = statusLabel, color = statusColor)
        }
        Spacer(Modifier.height(8.dp))
        BenefitRow(form.benefits)

        application?.let {
            Spacer(Modifier.height(6.dp))
            Text(
                text = "Filed ${shortTimestamp(it.submittedAt)}",
                color = OnDarkMedium.copy(alpha = 0.8f),
                fontSize = 10.sp,
            )
        }

        form.unsupportedFields.firstOrNull()?.let { field ->
            Spacer(Modifier.height(8.dp))
            Text(
                text = "This form now asks a question (${field.label}) that this version of the app cannot " +
                    "answer. Update the app, or apply from a browser.",
                color = OnDarkMedium,
                fontSize = 11.sp,
            )
        }

        Spacer(Modifier.height(10.dp))
        when (application?.statusEnum) {
            ApplicationStatus.PENDING -> VoizaButton(
                text = "Open the application",
                onClick = { onOpenRole(form.role) },
                gradient = Brush.horizontalGradient(listOf(VoizaSurface, VoizaSurfaceVariant)),
                height = 44,
                modifier = Modifier.fillMaxWidth(),
            )
            ApplicationStatus.INFO_REQUESTED -> VoizaButton(
                text = "Answer their question",
                onClick = { onOpenRole(form.role) },
                height = 44,
                modifier = Modifier.fillMaxWidth(),
            )
            else -> VoizaButton(
                text = if (entry.granted) "Role active" else form.title.ifBlank { "Apply" },
                onClick = { onOpenRole(form.role) },
                enabled = !entry.granted,
                height = 44,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
