package com.voiza.app.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.VoizaSurfaceVariant

/**
 * Shimmering placeholder block. Lists render these instead of a blank screen
 * while the first page is in flight, so the layout never jumps when data lands.
 */
@Composable
fun SkeletonBlock(
    modifier: Modifier = Modifier,
    cornerRadius: androidx.compose.ui.unit.Dp = 12.dp,
) {
    val transition = rememberInfiniteTransition(label = "skeleton")
    val shift by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Restart),
        label = "skeletonShift",
    )
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(cornerRadius))
            .background(
                Brush.linearGradient(
                    colors = listOf(
                        VoizaSurfaceHigh,
                        VoizaSurfaceVariant.copy(alpha = 0.55f + 0.45f * shift),
                        VoizaSurfaceHigh,
                    ),
                ),
            ),
    )
}

/** Room-card-shaped skeleton used by the lobby and discover grids. */
@Composable
fun RoomCardSkeleton(modifier: Modifier = Modifier) {
    Column(modifier = modifier.clip(RoundedCornerShape(16.dp)).background(VoizaSurfaceHigh)) {
        SkeletonBlock(
            modifier = Modifier.fillMaxWidth().height(110.dp),
            cornerRadius = 0.dp,
        )
        Column(modifier = Modifier.padding(10.dp)) {
            SkeletonBlock(modifier = Modifier.fillMaxWidth().height(14.dp))
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                SkeletonBlock(modifier = Modifier.size(20.dp), cornerRadius = 50.dp)
                Spacer(Modifier.width(6.dp))
                SkeletonBlock(modifier = Modifier.width(72.dp).height(10.dp))
            }
        }
    }
}

/** Grid of room-card skeletons for a first load. */
@Composable
fun RoomGridSkeleton(count: Int = 6, modifier: Modifier = Modifier) {
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        repeat(count / 2 + count % 2) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                RoomCardSkeleton(Modifier.weight(1f))
                if (it * 2 + 1 < count) RoomCardSkeleton(Modifier.weight(1f))
            }
        }
    }
}

/** Horizontal row of circular avatar skeletons (audience / friends strips). */
@Composable
fun AvatarRowSkeleton(count: Int = 8, size: androidx.compose.ui.unit.Dp = 36.dp) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        repeat(count) {
            SkeletonBlock(modifier = Modifier.size(size), cornerRadius = 50.dp)
        }
    }
}

/** Vertical rows of avatar + text-line skeletons (friends, rankings, ledger lists). */
@Composable
fun ListSkeleton(rows: Int = 6, modifier: Modifier = Modifier) {
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        repeat(rows) {
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                SkeletonBlock(modifier = Modifier.size(40.dp), cornerRadius = 50.dp)
                Spacer(Modifier.width(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    SkeletonBlock(modifier = Modifier.fillMaxWidth(0.55f).height(14.dp))
                    Spacer(Modifier.height(7.dp))
                    SkeletonBlock(modifier = Modifier.fillMaxWidth(0.35f).height(10.dp))
                }
            }
        }
    }
}
