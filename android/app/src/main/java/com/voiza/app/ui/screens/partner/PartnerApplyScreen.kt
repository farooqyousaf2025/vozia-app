package com.voiza.app.ui.screens.partner

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.AgencyOption
import com.voiza.app.domain.model.ApplicationField
import com.voiza.app.domain.model.ApplicationFieldInput
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.screens.home.voizaChipColors
import com.voiza.app.ui.screens.home.voizaFieldColors
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.RCoinGreen
import com.voiza.app.ui.theme.VoizaSurface
import com.voiza.app.ui.theme.WarningAmber
import com.voiza.app.viewmodel.PartnerApplyViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * One partner application, drawn from the server's spec.
 *
 * There is no Host form and no Coin Seller form in this file. There is a renderer that walks `fields`
 * and asks each question in the widget its `input` names, which is why a question added in the
 * backend shows up here without a release — and why the member is never asked something the server
 * will not store.
 *
 * Nothing is checked before sending. A required answer, a country that is not two letters, a
 * confirmation left unticked: each comes back as the server's own sentence and the screen shows it
 * unchanged. A client that validated first would be a client that could be wrong about the rules.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PartnerApplyScreen(
    role: String,
    onBack: () -> Unit,
    viewModel: PartnerApplyViewModel = viewModel(
        factory = voizaViewModelFactory { PartnerApplyViewModel() },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    LaunchedEffect(role) {
        if (state.form == null) viewModel.load(role)
    }

    val form = state.form

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
    ) {
        PartnerHeader(
            title = form?.title?.ifBlank { role } ?: "Application",
            subtitle = form?.blurb,
            onBack = onBack,
        )
        Spacer(Modifier.height(14.dp))

        if (state.loading && form == null) {
            LoadingProgress(overlay = false)
            return@Column
        }
        if (form == null) {
            PartnerError(state.error ?: "This application could not be loaded.")
            return@Column
        }

        // The form is gone once it has been sent, so what is left on screen is the fact of it.
        // Going back re-reads the hub's catalogue, which is where the new status lives.
        if (state.done) {
            NoticeCard(
                text = if (state.doneWasReply) {
                    "Your answer was added to this application. It is back with an operator, waiting to " +
                        "be decided, and the questions you did not change stayed as they were."
                } else {
                    "Application filed. An operator reads it and decides; nothing about your account " +
                        "changes until they approve it." +
                        (state.openApplication?.let { " Filed ${shortTimestamp(it.submittedAt)}." } ?: "")
                },
                color = RCoinGreen,
            )
            Spacer(Modifier.height(16.dp))
            VoizaButton(
                text = "Back to partner roles",
                onClick = {
                    viewModel.consumedDone()
                    onBack()
                },
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(30.dp))
            return@Column
        }

        BenefitRow(form.benefits)
        Spacer(Modifier.height(14.dp))

        if (state.inReview) {
            NoticeCard(
                text = "This application is with an operator, filed " +
                    "${shortTimestamp(state.openApplication?.submittedAt)}. What is below is what you sent; " +
                    "a second submission is refused until it is decided.",
                color = WarningAmber,
            )
            Spacer(Modifier.height(14.dp))
        }

        if (state.isReply) {
            NoticeCard(
                text = "An operator needs something else before deciding: " +
                    (state.openApplication?.infoRequestNote ?: "answer the questions below."),
                color = OnDarkHigh,
            )
            Spacer(Modifier.height(14.dp))
        }

        form.fields.forEach { field ->
            FieldInput(
                field = field,
                value = state.answers[field.key],
                enabled = !state.inReview,
                agencies = state.agencies,
                onChange = { viewModel.setAnswer(field.key, it) },
            )
            Spacer(Modifier.height(12.dp))
        }

        if (form.unsupportedFields.isNotEmpty()) {
            Text(
                text = "This form asks at least one question this version of the app cannot show. Update " +
                    "the app — the server refuses a submission that leaves it out.",
                color = DangerRed,
                fontSize = 12.sp,
            )
            Spacer(Modifier.height(10.dp))
        }

        PartnerError(state.error)

        if (!state.inReview) {
            VoizaButton(
                text = when {
                    state.submitting -> "Sending…"
                    state.isReply -> "Send your answer"
                    else -> "Submit application"
                },
                onClick = { viewModel.submit() },
                enabled = !state.submitting,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Spacer(Modifier.height(10.dp))
        Text(
            text = "An operator reads this. Applying, and answering a question, changes nothing on your " +
                "account by itself — only an approval does.",
            color = OnDarkMedium,
            fontSize = 11.sp,
        )
        Spacer(Modifier.height(30.dp))
    }
}

/** The one widget per question kind. A kind this build does not know says so instead of guessing. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun FieldInput(
    field: ApplicationField,
    value: Any?,
    enabled: Boolean,
    agencies: List<AgencyOption>,
    onChange: (Any?) -> Unit,
) {
    val label = if (field.required) field.label else "${field.label} (optional)"
    val text = if (value is Boolean || value == null) "" else value.toString()
    // A `max` on a number field is the value's ceiling, not a character count, so the only widget
    // that must not print "3/5000" is the one whose ceiling is a salary.
    val charCounter = if (field.input == ApplicationFieldInput.NUMBER) {
        null
    } else {
        field.max?.let { "${text.length.coerceAtMost(it)}/$it" }
    }

    when (field.input) {
        ApplicationFieldInput.CHECKBOX -> {
            FilterChip(
                selected = value == true,
                onClick = { if (enabled) onChange(!(value == true)) },
                leadingIcon = if (value == true) {
                    {
                        Icon(
                            imageVector = Icons.Default.Check,
                            contentDescription = "Confirmed",
                            modifier = Modifier.size(18.dp),
                        )
                    }
                } else {
                    null
                },
                label = { Text(field.label, fontSize = 13.sp) },
                colors = voizaChipColors(),
            )
            FieldNote(field.hint, null)
        }

        ApplicationFieldInput.AGENCY -> {
            SectionLabel(label)
            // Every agency the operator lists has to be tappable. Sideways scrolling put the third
            // chip past the bezel with no affordance, so a member could only ever pick from the two
            // that happened to fit; this block grows downward instead, and the form already scrolls.
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                FilterChip(
                    selected = text.isBlank(),
                    onClick = { if (enabled) onChange("") },
                    label = { Text("No preference", fontSize = 12.sp) },
                    colors = voizaChipColors(),
                )
                agencies.forEach { agency ->
                    FilterChip(
                        selected = text == agency.id,
                        onClick = { if (enabled) onChange(agency.id) },
                        label = { Text(agency.name.ifBlank { "Agency" }, fontSize = 12.sp) },
                        colors = voizaChipColors(),
                    )
                }
                // An answer filed earlier can name an agency that is no longer on this shortlist.
                if (text.isNotBlank() && agencies.none { it.id == text }) {
                    FilterChip(
                        selected = true,
                        onClick = { },
                        enabled = false,
                        label = { Text("Agency ${text.take(8)} (no longer listed)", fontSize = 12.sp) },
                        colors = voizaChipColors(),
                    )
                }
            }
            FieldNote(field.hint, null)
        }

        ApplicationFieldInput.UNSUPPORTED -> {
            SectionLabel(label)
            Text(
                text = "This question needs a newer version of the app.",
                color = DangerRed,
                fontSize = 12.sp,
            )
        }

        else -> {
            SectionLabel(label)
            OutlinedTextField(
                value = text,
                onValueChange = { next ->
                    if (enabled) {
                        onChange(
                            when (field.input) {
                                ApplicationFieldInput.COUNTRY -> next.uppercase().take(2)
                                ApplicationFieldInput.NUMBER -> next.filter { it.isDigit() }.take(12)
                                else -> next.take(field.max ?: 120)
                            },
                        )
                    }
                },
                enabled = enabled,
                singleLine = field.input != ApplicationFieldInput.TEXTAREA,
                minLines = if (field.input == ApplicationFieldInput.TEXTAREA) 3 else 1,
                keyboardOptions = KeyboardOptions(
                    keyboardType = when (field.input) {
                        ApplicationFieldInput.NUMBER -> KeyboardType.Number
                        ApplicationFieldInput.PHONE -> KeyboardType.Phone
                        ApplicationFieldInput.EMAIL -> KeyboardType.Email
                        else -> KeyboardType.Text
                    },
                ),
                colors = voizaFieldColors(),
                modifier = Modifier.fillMaxWidth(),
            )
            FieldNote(field.hint, charCounter)
        }
    }
}

/**
 * The one place a question's own words are printed. They used to sit in the box as a placeholder and
 * again underneath, which read as two different notes about the same field.
 */
@Composable
private fun FieldNote(hint: String?, charCounter: String?) {
    val line = listOfNotNull(hint, charCounter).joinToString(" · ")
    if (line.isBlank()) return
    Spacer(Modifier.height(4.dp))
    Text(text = line, color = OnDarkMedium, fontSize = 11.sp)
}

@Composable
private fun NoticeCard(text: String, color: Color) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        Text(text, color = color, fontSize = 12.sp, fontWeight = FontWeight.Medium)
    }
}
