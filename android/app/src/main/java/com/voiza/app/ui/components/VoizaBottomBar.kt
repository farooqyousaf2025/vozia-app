package com.voiza.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Explore
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.Violet
import com.voiza.app.ui.theme.VoizaCardBorder
import com.voiza.app.ui.theme.VoizaCtaGradient
import com.voiza.app.ui.theme.VoizaSurface

/** The four stable tabs of the shell; Create Room is an action, not a tab. */
enum class VoizaNavTab { HOME, DISCOVER, MESSAGES, PROFILE }

/**
 * The app's shell bar: Home, Discover, Create Room, Messages, Profile.
 *
 * A custom row rather than Material `NavigationBar` because the centre action is
 * a raised gradient disc that breaks the bar's baseline — the Android-native
 * "compose FAB in the bar" pattern. Selected state rides on the purple; the
 * disc is always the primary gradient because it is the app's main verb.
 * The bar draws its own navigation-bar inset so it sits above gesture nav.
 */
@Composable
fun VoizaBottomBar(
    current: VoizaNavTab,
    onHome: () -> Unit,
    onDiscover: () -> Unit,
    onCreateRoom: () -> Unit,
    onMessages: () -> Unit,
    onProfile: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(VoizaSurface),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(VoizaCardBorder),
        )
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceEvenly,
            modifier = Modifier
                .fillMaxWidth()
                .height(60.dp)
                .padding(horizontal = 6.dp),
        ) {
            BarItem(
                icon = Icons.Default.Home,
                label = "Home",
                selected = current == VoizaNavTab.HOME,
                onClick = onHome,
            )
            BarItem(
                icon = Icons.Default.Explore,
                label = "Discover",
                selected = current == VoizaNavTab.DISCOVER,
                onClick = onDiscover,
            )
            CreateRoomAction(onClick = onCreateRoom)
            BarItem(
                icon = Icons.AutoMirrored.Filled.Chat,
                label = "Messages",
                selected = current == VoizaNavTab.MESSAGES,
                onClick = onMessages,
            )
            BarItem(
                icon = Icons.Default.Person,
                label = "Profile",
                selected = current == VoizaNavTab.PROFILE,
                onClick = onProfile,
            )
        }
        Spacer(Modifier.navigationBarsPadding())
    }
}

@Composable
private fun RowScope.BarItem(
    icon: ImageVector,
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .clip(RoundedCornerShape(14.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = label,
            tint = if (selected) Violet else OnDarkMuted,
            modifier = Modifier.size(23.dp),
        )
        Spacer(Modifier.height(3.dp))
        Text(
            text = label,
            color = if (selected) OnDarkHigh else OnDarkMuted,
            fontSize = 10.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
        )
    }
}

/** Raised centre action: the create-room verb, visually above the bar's baseline. */
@Composable
private fun CreateRoomAction(onClick: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .offset(y = (-10).dp)
            .size(50.dp)
            .clip(CircleShape)
            .background(VoizaCtaGradient)
            .clickable(onClick = onClick),
    ) {
        Icon(
            imageVector = Icons.Default.Add,
            contentDescription = "Create room",
            tint = OnDarkHigh,
            modifier = Modifier.size(26.dp),
        )
    }
}
