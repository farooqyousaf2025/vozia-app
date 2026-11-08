package com.voiza.app.ui.screens.partner

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Work
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.ApplicationGrant
import com.voiza.app.domain.model.ApplicationStatus
import com.voiza.app.domain.model.PartnerRole
import com.voiza.app.domain.model.RoleApplication
import com.voiza.app.domain.model.prettify
import com.voiza.app.ui.components.EmptyState
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.components.VoizaSecondaryButton
import com.voiza.app.ui.components.VoizaTextButton
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.RCoinGreen
import com.voiza.app.ui.theme.VoizaSurface
import com.voiza.app.viewmodel.MyApplicationsViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * Every application this account has filed, including the ones that ended badly.
 *
 * The rows come from `GET /api/role-applications/mine` and are shown in the server's order. A
 * declined application and a revoked role stay here with the operator's sentence attached, because
 * the audit trail is the only place a member can learn why an approval did not happen.
 *
 * Nothing here decides what the account is allowed to do. `activeRoles` is a list of `APPROVED`
 * rows drawn as text; the privilege itself lives in those rows on the server and is re-checked
 * there on every request.
 */
@Composable
fun MyApplicationsScreen(
    onBack: () -> Unit,
    onOpenRole: (String) -> Unit,
    viewModel: MyApplicationsViewModel = viewModel(
        factory = voizaViewModelFactory { MyApplicationsViewModel() },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    // A decision, or a request for more information, can land while the member is elsewhere.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { viewModel.load() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 20.dp, vertical = 20.dp),
    ) {
        PartnerHeader(
            title = "My applications",
            subtitle = "What you asked for, what you sent, and what an operator decided.",
            onBack = onBack,
        )

        state.message?.let { PartnerSnack(text = it, onConsumed = viewModel::consumeMessage) }
        PartnerError(state.error)

        if (state.loading && state.applications.isEmpty()) {
            LoadingProgress(overlay = false)
            return@Column
        }
        if (state.applications.isEmpty()) {
            EmptyState(
                icon = Icons.Default.Work,
                title = "No applications yet",
                subtitle = "When you apply for a role, the form you sent and the answer you get stay listed here.",
                action = { VoizaSecondaryButton(text = "Back", onClick = onBack) },
            )
            return@Column
        }

        Spacer(Modifier.height(10.dp))
        Text(
            text = if (state.activeRoles.isEmpty()) {
                "No partner role is active on this account yet."
            } else {
                "Active: " + state.activeRoles.joinToString { PartnerRole.fromWire(it)?.label ?: prettify(it) }
            },
            color = if (state.activeRoles.isEmpty()) OnDarkMedium else RCoinGreen,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.height(6.dp))

        LazyColumn(
            contentPadding = PaddingValues(vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        ) {
            items(state.applications, key = { it.id }) { application ->
                ApplicationRow(
                    application = application,
                    answers = viewModel.answerLines(application),
                    busy = state.busyId == application.id,
                    onAnswer = { onOpenRole(application.role) },
                    onWithdraw = { viewModel.withdraw(application.id) },
                )
            }
        }
    }
}

@Composable
private fun ApplicationRow(
    application: RoleApplication,
    answers: List<Pair<String, String>>,
    busy: Boolean,
    onAnswer: () -> Unit,
    onWithdraw: () -> Unit,
) {
    var showAnswers by remember(application.id) { mutableStateOf(false) }
    val (statusLabel, statusColor) = statusPresentation(application)

    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = application.roleLabel,
                color = OnDarkHigh,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            StatusPill(label = statusLabel, color = statusColor)
        }
        Spacer(Modifier.height(4.dp))
        Text(
            text = "Filed ${shortTimestamp(application.submittedAt)}",
            color = OnDarkMedium.copy(alpha = 0.8f),
            fontSize = 10.sp,
        )

        application.noteForApplicant?.takeIf { it.isNotBlank() }?.let { note ->
            Spacer(Modifier.height(8.dp))
            Text(
                text = leadIn(application.statusEnum),
                color = statusColor,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(note, color = OnDarkHigh, fontSize = 12.sp)
        }

        application.grant?.let { grant ->
            grantSummary(grant)?.let { summary ->
                Spacer(Modifier.height(8.dp))
                Text(summary, color = OnDarkMedium, fontSize = 11.sp)
            }
        }

        if (answers.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            VoizaTextButton(
                text = if (showAnswers) "Hide what you sent" else "Show what you sent",
                onClick = { showAnswers = !showAnswers },
                color = Cyan,
                modifier = Modifier.fillMaxWidth(),
            )
            if (showAnswers) {
                answers.forEach { (label, value) ->
                    Row(modifier = Modifier.fillMaxWidth()) {
                        Text(
                            text = label,
                            color = OnDarkMedium,
                            fontSize = 11.sp,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(10.dp))
                        Text(
                            text = value,
                            color = OnDarkHigh,
                            fontSize = 11.sp,
                            textAlign = TextAlign.End,
                            modifier = Modifier.weight(1.1f),
                        )
                    }
                    Spacer(Modifier.height(4.dp))
                }
            }
        }

        // Only a row still in front of someone can be taken back; a decided one is history.
        if (application.isOpen) {
            Spacer(Modifier.height(6.dp))
            if (application.needsApplicant) {
                VoizaButton(
                    text = "Answer their request",
                    onClick = onAnswer,
                    enabled = !busy,
                    height = 44,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(4.dp))
            }
            VoizaTextButton(
                text = if (busy) "Withdrawing…" else "Withdraw application",
                onClick = onWithdraw,
                color = if (busy) OnDarkMedium else DangerRed,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** The operator's sentence means something different in each state, so it is introduced as such. */
private fun leadIn(status: ApplicationStatus?): String = when (status) {
    ApplicationStatus.INFO_REQUESTED -> "The operator asked for more information."
    ApplicationStatus.REJECTED -> "Why it was not approved."
    ApplicationStatus.REVOKED -> "Why the role was taken back."
    ApplicationStatus.APPROVED -> "What the operator wrote."
    else -> "Note from the review."
}

/** What the approval opened, in the server's own words: an agency, a business account, a host marker. */
private fun grantSummary(grant: ApplicationGrant): String? {
    val kind = grant.kind ?: return null
    return listOfNotNull(
        prettify(kind),
        grant.label?.takeIf { it.isNotBlank() },
        grant.status?.takeIf { it.isNotBlank() },
    ).joinToString(" · ")
}
