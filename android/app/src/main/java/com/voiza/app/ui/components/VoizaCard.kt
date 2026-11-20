package com.voiza.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.unit.dp
import com.voiza.app.domain.model.BubbleMotif
import com.voiza.app.domain.model.BubbleStyle
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.VoizaCardBorder
import com.voiza.app.ui.theme.VoizaSurfaceHigh

/**
 * Standard Vozia card: charcoal surface, 18dp radius, hairline border so a
 * card reads as an object on the black ground without a drop shadow.
 */
@Composable
fun VoizaCard(
    modifier: Modifier = Modifier,
    backgroundColor: Color = MaterialTheme.colorScheme.surface,
    bordered: Boolean = true,
    contentPadding: androidx.compose.ui.unit.Dp = 14.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(18.dp))
            .background(backgroundColor)
            .then(if (bordered) Modifier.border(1.dp, VoizaCardBorder, RoundedCornerShape(18.dp)) else Modifier)
            .padding(contentPadding),
        content = content,
    )
}

/** Static, content-sized chat panel shared by room messages and the shop's real text preview. */
@Composable
fun ChatBubblePanel(
    style: BubbleStyle?,
    modifier: Modifier = Modifier,
    plainBackground: Color = Color(0x26000000),
    content: @Composable (textColor: Color, accent: Color) -> Unit,
) {
    val background = remember(style, plainBackground) {
        if (style == null) plainBackground
        else BubbleStyle.parseColor(style.background)?.let { Color(it) } ?: VoizaSurfaceHigh
    }
    val accent = remember(style) { BubbleStyle.parseColor(style?.accent)?.let { Color(it) } ?: Cyan }
    val textColor = remember(style) { BubbleStyle.parseColor(style?.textColor)?.let { Color(it) } ?: OnDarkHigh }
    val motif = BubbleMotif.fromWire(style?.motif)
    val shape = if (style == null) RoundedCornerShape(12.dp)
    else RoundedCornerShape(topStart = 6.dp, topEnd = 18.dp, bottomEnd = 18.dp, bottomStart = 18.dp)
    val innerShape = RoundedCornerShape(topStart = 4.dp, topEnd = 15.dp, bottomEnd = 15.dp, bottomStart = 15.dp)
    Box(
        modifier = modifier
            .clip(shape)
            .background(background)
            .then(
                if (style == null) Modifier else Modifier
                    .border(1.dp, accent.copy(alpha = 0.65f), shape)
                    .padding(3.dp)
                    .border(0.5.dp, accent.copy(alpha = 0.25f), innerShape),
            ),
    ) {
        Box(
            modifier = if (style == null) Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
            else Modifier.padding(start = 9.dp, top = 6.dp, end = if (motif == BubbleMotif.NONE) 9.dp else 24.dp, bottom = 6.dp),
        ) {
            content(textColor, accent)
        }
        if (motif != BubbleMotif.NONE) {
            // Decorative only: no semantics, animation or pointer handling. The reserved end inset
            // keeps the ornament clear of both the username and wrapped text, including in RTL.
            val ornament = remember(motif) {
                Path().apply {
                    when (motif) {
                        BubbleMotif.SPARKLE -> {
                            moveTo(6f, 0f); lineTo(7.7f, 4.3f); lineTo(12f, 6f)
                            lineTo(7.7f, 7.7f); lineTo(6f, 12f); lineTo(4.3f, 7.7f)
                            lineTo(0f, 6f); lineTo(4.3f, 4.3f)
                        }
                        BubbleMotif.HEART -> {
                            moveTo(6f, 11f)
                            cubicTo(4f, 9f, 0f, 6.5f, 0f, 3.5f)
                            cubicTo(0f, 0f, 4f, 0f, 6f, 3f)
                            cubicTo(8f, 0f, 12f, 0f, 12f, 3.5f)
                            cubicTo(12f, 6.5f, 8f, 9f, 6f, 11f)
                        }
                        BubbleMotif.CROWN -> {
                            moveTo(1.5f, 10f); lineTo(0f, 2f); lineTo(3.5f, 5f)
                            lineTo(6f, 0f); lineTo(8.5f, 5f); lineTo(12f, 2f); lineTo(10.5f, 10f)
                        }
                        BubbleMotif.NONE -> Unit
                    }
                    close()
                }
            }
            Canvas(Modifier.align(Alignment.TopEnd).padding(top = 5.dp, end = 7.dp).size(12.dp)) {
                scale(size.width / 12f, size.height / 12f, pivot = Offset.Zero) {
                    drawPath(ornament, accent)
                }
            }
        }
    }
}
