package com.voiza.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.OnDarkHigh

/** Destructive action button (kick / close room / logout). */
@Composable
fun DangerButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val shape = RoundedCornerShape(14.dp)
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .height(46.dp)
            .clip(shape)
            .background(if (enabled) DangerRed.copy(alpha = 0.22f) else Color(0xFF241F3D))
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 14.dp),
    ) {
        Text(
            text = text,
            color = if (enabled) DangerRed else Color(0xFF6A6490),
            fontWeight = FontWeight.Bold,
            fontSize = 14.sp,
        )
    }
}
