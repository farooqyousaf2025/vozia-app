package com.voiza.app.ui.screens.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Verified
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.User
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.DiamondChip
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.components.VoizaSecondaryButton
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.RCoinGreen
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.DiamondGold
import com.voiza.app.ui.theme.Violet
import com.voiza.app.ui.theme.VioletLight
import com.voiza.app.ui.theme.VoizaBackground
import com.voiza.app.ui.theme.VoizaGoldGradient
import com.voiza.app.ui.theme.VoizaHeroGradient
import com.voiza.app.ui.theme.VoizaOutline
import com.voiza.app.ui.theme.VoizaSurfaceVariant
import com.voiza.app.ui.theme.WarningAmber
import com.voiza.app.viewmodel.AgencyAccessViewModel
import com.voiza.app.viewmodel.AuthViewModel
import com.voiza.app.viewmodel.PartnerAccessViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * Profile: identity header (agency/host badges), wallet link, lifetime gift
 * stats, the Become a Partner entry, the agency desk for a member who runs one,
 * edit-profile dialog (PATCH /api/auth/me) and logout.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(
    onBack: () -> Unit,
    onOpenWallet: () -> Unit,
    onOpenFriends: () -> Unit,
    onOpenStore: () -> Unit,
    onOpenQuests: () -> Unit,
    onOpenPartner: () -> Unit,
    onOpenAgency: () -> Unit,
    onOpenPartnerDesk: () -> Unit,
    onLoggedOut: () -> Unit,
    viewModel: AuthViewModel = viewModel(
        factory = voizaViewModelFactory { AuthViewModel() },
    ),
    agencyViewModel: AgencyAccessViewModel = viewModel(
        factory = voizaViewModelFactory { AgencyAccessViewModel() },
    ),
    partnerViewModel: PartnerAccessViewModel = viewModel(
        factory = voizaViewModelFactory { PartnerAccessViewModel() },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val user = state.loggedInUser
    val runsAgency by agencyViewModel.runsAgency.collectAsStateWithLifecycle()
    val runsPartnerAccount by partnerViewModel.runsPartnerAccount.collectAsStateWithLifecycle()

    // The server answers whether this member runs an agency, and it answers again every time the tab is
    // opened: a grant, a revoke or a suspension all change the entry without a reinstall.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { agencyViewModel.check() }
    // Same for the seller/BD desk: the account's ACTIVE status is re-read on every probe.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { partnerViewModel.check() }

    var editOpen by remember { mutableStateOf(false) }
    var logoutOpen by remember { mutableStateOf(false) }

    LaunchedEffect(state.profileSaved) {
        if (state.profileSaved) {
            editOpen = false
            viewModel.acknowledgeProfileSaved()
        }
    }
    LaunchedEffect(user) {
        if (user == null && state.step == AuthViewModel.AuthUiState.Step.LOGGED_IN) {
            // Logged out while on this screen.
            onLoggedOut()
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState()),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(6.dp)) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = OnDarkHigh)
            }
            Text("Profile", color = OnDarkHigh, fontSize = 19.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            IconButton(onClick = { editOpen = true }) {
                Icon(Icons.Default.Edit, contentDescription = "Edit profile", tint = VioletLight)
            }
        }

        // ---- Identity header ----
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    VoizaHeroGradient
                )
                .padding(vertical = 22.dp, horizontal = 16.dp),
        ) {
            Avatar(
                url = user?.avatarUrl,
                name = user?.username,
                size = 92.dp,
                ringBrush = Brush.sweepGradient(listOf(Fuchsia, Cyan, Fuchsia)),
                ringWidth = 3.dp,
                frame = user?.profileFrame,
            )
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = user?.username ?: "Guest",
                    color = OnDarkHigh,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                )
                if (user?.isVerified == true) {
                    Spacer(Modifier.width(6.dp))
                    Icon(Icons.Default.Verified, contentDescription = "Verified", tint = Cyan, modifier = Modifier.size(16.dp))
                }
            }
            user?.bio?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(6.dp))
                Text(it, color = OnDarkMedium, fontSize = 12.sp)
            }
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                user?.let { RoleBadge(it) }
                // The spend tier is the one status money cannot buy, so it sits with the role.
                user?.takeIf { it.vipLevel > 0 }?.let { VipBadge(it.vipLevel) }
                DiamondChip(balance = user?.diamondBalance)
            }
        }

        // ---- Stats ----
        VoizaCard(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.SpaceBetween,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Stat("Gifts sent", (user?.totalGiftsSent ?: 0).toString(), Fuchsia)
                Stat("Gifts received", (user?.totalGiftsReceived ?: 0).toString(), RCoinGreen)
                Stat("R-Coins", (user?.rCoinBalance ?: 0).toString(), Cyan)
            }
        }

        // ---- Actions ----
        VoizaButton(
            text = "Daily quests",
            onClick = onOpenQuests,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
        )
        Spacer(Modifier.height(8.dp))
        VoizaButton(
            text = "Cosmetic store",
            onClick = onOpenStore,
            gradient = Brush.horizontalGradient(listOf(VoizaSurfaceVariant, VoizaSurfaceHigh)),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
        )
        Spacer(Modifier.height(8.dp))
        VoizaButton(
            text = "Open wallet",
            onClick = onOpenWallet,
            gradient = Brush.horizontalGradient(listOf(VoizaSurfaceVariant, VoizaSurfaceHigh)),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
        )
        Spacer(Modifier.height(8.dp))
        VoizaButton(
            text = "Friends & messages",
            onClick = onOpenFriends,
            gradient = Brush.horizontalGradient(listOf(VoizaSurfaceVariant, VoizaSurfaceHigh)),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
        )
        Spacer(Modifier.height(8.dp))
        VoizaButton(
            text = "Become a Partner",
            onClick = onOpenPartner,
            gradient = Brush.horizontalGradient(listOf(VoizaSurfaceVariant, VoizaSurfaceHigh)),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
        )
        // The agency desk, offered to a member the platform's own route claims as an agency owner.
        //
        // This is the only entry in the app gated on a role, and it gates presentation, not permission:
        // every `/api/agency` route re-reads `agencies.owner_user_id` on the request whatever this button
        // decided. It asks the server rather than reading `userType` because that column is raised when an
        // operator approves an AGENCY application and never lowered, and an agency created any other way
        // leaves it at USER — so it both hides the desk from real owners and keeps offering it to
        // withdrawn ones. The answer is the same lookup the desk is served by.
        if (runsAgency == true) {
            Spacer(Modifier.height(8.dp))
            VoizaButton(
                text = "Agency desk",
                onClick = onOpenAgency,
                gradient = Brush.horizontalGradient(listOf(VoizaSurfaceVariant, VoizaSurfaceHigh)),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp),
            )
        }
        // The seller/BD desk, gated the same way and for the same reason: the server re-reads
        // `business_accounts.owner_user_id` and the ACTIVE status on every `/api/partner` request,
        // so a suspension or a revoke takes the entry away on the next resume without a reinstall.
        if (runsPartnerAccount == true) {
            Spacer(Modifier.height(8.dp))
            VoizaButton(
                text = "Partner desk",
                onClick = onOpenPartnerDesk,
                gradient = Brush.horizontalGradient(listOf(VoizaSurfaceVariant, VoizaSurfaceHigh)),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp),
            )
        }
        Spacer(Modifier.height(8.dp))
        VoizaSecondaryButton(
            text = "Logout",
            onClick = { logoutOpen = true },
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
        )

        state.error?.let {
            Spacer(Modifier.height(10.dp))
            Text(it, color = DangerRed, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp))
        }
        Spacer(Modifier.height(30.dp))
    }

    if (editOpen) {
        EditProfileDialog(
            user = user,
            saving = state.loading,
            onDismiss = { editOpen = false },
            onSave = { name, avatar, bio -> viewModel.updateProfile(name, avatar, bio) },
        )
    }

    if (logoutOpen) {
        AlertDialog(
            onDismissRequest = { logoutOpen = false },
            containerColor = VoizaSurfaceHigh,
            title = { Text("Logout?", color = OnDarkHigh) },
            text = { Text("You will need a new SMS code to re-enter Voiza.", color = OnDarkMedium, fontSize = 13.sp) },
            confirmButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null, tint = DangerRed)
                    TextButton(onClick = { viewModel.logout(); onLoggedOut() }) {
                        Text("Logout", color = DangerRed, fontWeight = FontWeight.Bold)
                    }
                }
            },
            dismissButton = {
                TextButton(onClick = { logoutOpen = false }) {
                    Text("Stay", color = OnDarkMedium)
                }
            },
        )
    }
}

@Composable
private fun RoleBadge(user: User) {
    val (label, brush) = when (user.userType.uppercase()) {
        "HOST" -> "HOST" to Brush.horizontalGradient(listOf(Violet, VioletLight))
        "AGENCY_ADMIN" -> "AGENCY" to Brush.horizontalGradient(listOf(WarningAmber, DiamondGold))
        "COIN_SELLER" -> "SELLER" to Brush.horizontalGradient(listOf(RCoinGreen, VioletLight))
        "BD_MANAGER" -> "BD MANAGER" to VoizaGoldGradient
        "BD_AGENT" -> "BD AGENT" to Brush.horizontalGradient(listOf(VioletLight, Violet))
        else -> "MEMBER" to Brush.horizontalGradient(listOf(VoizaSurfaceVariant, VoizaSurfaceHigh))
    }
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(brush)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(label, color = OnDarkHigh, fontSize = 10.sp, fontWeight = FontWeight.Black)
    }
}

@Composable
private fun VipBadge(level: Int) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(VoizaGoldGradient)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text("VIP $level", color = VoizaBackground, fontSize = 10.sp, fontWeight = FontWeight.Black)
    }
}

@Composable
private fun Stat(label: String, value: String, color: Color) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, color = color, fontSize = 22.sp, fontWeight = FontWeight.Black)
        Text(label, color = OnDarkMedium, fontSize = 11.sp)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EditProfileDialog(
    user: User?,
    saving: Boolean,
    onDismiss: () -> Unit,
    onSave: (username: String?, avatarUrl: String?, bio: String?) -> Unit,
) {
    var username by remember { mutableStateOf(user?.username ?: "") }
    var avatarUrl by remember { mutableStateOf(user?.avatarUrl ?: "") }
    var bio by remember { mutableStateOf(user?.bio ?: "") }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = VoizaSurfaceHigh,
        shape = RoundedCornerShape(22.dp),
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Edit, contentDescription = null, tint = VioletLight)
                Spacer(Modifier.width(8.dp))
                Text("Edit profile", color = OnDarkHigh, fontWeight = FontWeight.Bold)
            }
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = username,
                    onValueChange = { username = it.take(40) },
                    label = { Text("Username", fontSize = 13.sp) },
                    singleLine = true,
                    colors = fieldColors(),
                )
                OutlinedTextField(
                    value = avatarUrl,
                    onValueChange = { avatarUrl = it.take(300) },
                    label = { Text("Avatar URL", fontSize = 13.sp) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    colors = fieldColors(),
                )
                OutlinedTextField(
                    value = bio,
                    onValueChange = { bio = it.take(200) },
                    label = { Text("Bio", fontSize = 13.sp) },
                    minLines = 2,
                    colors = fieldColors(),
                )
            }
        },
        confirmButton = {
            VoizaButton(
                text = if (saving) "Saving\u2026" else "Save",
                onClick = {
                    onSave(
                        username.trim().takeIf { it.isNotEmpty() && it != user?.username },
                        avatarUrl.trim().takeIf { it.isNotEmpty() },
                        bio.trim().takeIf { it != user?.bio },
                    )
                },
                enabled = !saving,
                height = 44,
                modifier = Modifier.width(140.dp),
            )
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", color = OnDarkMedium)
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Fuchsia,
    unfocusedBorderColor = VoizaOutline,
    focusedLabelColor = Fuchsia,
    unfocusedLabelColor = OnDarkMedium,
    cursorColor = Violet,
    focusedTextColor = OnDarkHigh,
    unfocusedTextColor = OnDarkHigh,
)

@Preview(showBackground = true)
@Composable
fun ProfileScreenPreview() {
    ProfileScreen(onBack = {}, onOpenWallet = {}, onOpenFriends = {}, onOpenStore = {}, onOpenQuests = {}, onOpenPartner = {}, onOpenAgency = {}, onOpenPartnerDesk = {}, onLoggedOut = {})
}
