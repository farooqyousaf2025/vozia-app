package com.voiza.app.ui.screens.partner

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.ApplicationStatus
import com.voiza.app.domain.model.RoleApplication
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.RCoinGreen
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.WarningAmber
import kotlinx.coroutines.delay

// ---------------------------------------------------------------------------
// Shared pieces for the three Become a Partner screens.
//
// A status colour lives here rather than in each screen because the same row appears on the hub, in
// the form's banner and in the history list, and the green that means "an operator granted this" has
// to be the same green in all three.
// ---------------------------------------------------------------------------

/** The header every partner screen opens with: back arrow, title, and one line of what follows. */
@Composable
internal fun PartnerHeader(title: String, subtitle: String?, onBack: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = OnDarkHigh)
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                color = OnDarkHigh,
                fontSize = 20.sp,
                fontWeight = FontWeight.Bold,
            )
            if (subtitle != null) {
                Text(text = subtitle, color = OnDarkMedium, fontSize = 12.sp)
            }
        }
    }
}

@Composable
internal fun SectionLabel(text: String) {
    Text(
        text = text,
        color = OnDarkHigh,
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(bottom = 6.dp),
    )
}

/** The colour an application's state is drawn in, and the words a member can read. */
internal fun statusPresentation(application: RoleApplication): Pair<String, Color> {
    val status = ApplicationStatus.fromWire(application.status)
    val colour = when (status) {
        ApplicationStatus.PENDING -> WarningAmber
        ApplicationStatus.INFO_REQUESTED -> Cyan
        ApplicationStatus.APPROVED -> RCoinGreen
        ApplicationStatus.REJECTED -> DangerRed
        ApplicationStatus.REVOKED -> DangerRed
        ApplicationStatus.CANCELLED -> OnDarkMedium
        // A state this build does not know is drawn neutral and labelled with the server's own word
        // rather than guessed at — an unknown status is not automatically a good one.
        null -> OnDarkMedium
    }
    return (status?.label ?: application.status) to colour
}

/** The state of a role on the hub, where there may be no row at all yet. */
internal fun entryPresentation(
    granted: Boolean,
    application: RoleApplication?,
): Pair<String, Color> = when {
    granted -> "Role active" to RCoinGreen
    application != null -> statusPresentation(application)
    else -> "Not applied" to OnDarkMedium
}

@Composable
internal fun StatusPill(label: String, color: Color, modifier: Modifier = Modifier) {
    Text(
        text = label,
        color = color,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

/**
 * What the role pays or gives, as the server wrote it.
 *
 * These wrap onto new lines rather than scrolling sideways: on a 1080px screen the third benefit sat
 * off the bezel with nothing to say another chip existed, so a member read two of the three the
 * operator listed. A wrapped row shows all of them at the cost of one line of height.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun BenefitRow(benefits: List<String>) {
    if (benefits.isEmpty()) return
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        benefits.forEach { benefit ->
            Text(
                text = benefit,
                color = OnDarkMedium,
                fontSize = 11.sp,
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(VoizaSurfaceHigh)
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
    }
}

/** `2026-11-08T18:59:12.4Z` reads as `2026-11-08 18:59`, the way the wallet shows its rows. */
internal fun shortTimestamp(iso: String?): String =
    iso?.take(16)?.replace('T', ' ') ?: "—"

/** One-shot confirmation snack; clears itself after 2.5 s. */
@Composable
internal fun PartnerSnack(text: String, onConsumed: () -> Unit) {
    LaunchedEffect(text) {
        delay(2500)
        onConsumed()
    }
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
        Text(
            text = text,
            color = OnDarkHigh,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .clip(RoundedCornerShape(10.dp))
                .background(Color(0xE6221B4E))
                .padding(horizontal = 14.dp, vertical = 8.dp),
        )
    }
}

/** A refusal from the server, shown as written. Nothing here re-explains a rule the backend owns. */
@Composable
internal fun PartnerError(text: String?) {
    if (text == null) return
    Spacer(Modifier.height(12.dp))
    Text(text, color = DangerRed, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
}
