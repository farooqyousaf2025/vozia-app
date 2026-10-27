package com.voiza.app.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.voiza.app.ui.theme.Fuchsia

/** Centered brand spinner; overlay variant fills its parent with a scrim. */
@Composable
fun LoadingProgress(
    modifier: Modifier = Modifier,
    size: Dp = 40.dp,
    overlay: Boolean = false,
) {
    if (overlay) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = modifier.fillMaxSize(),
        ) {
            CircularProgressIndicator(
                color = Fuchsia,
                trackColor = Fuchsia.copy(alpha = 0.15f),
                strokeWidth = 3.dp,
                modifier = Modifier.size(size),
            )
        }
    } else {
        Box(contentAlignment = Alignment.Center, modifier = modifier) {
            CircularProgressIndicator(
                color = Fuchsia,
                trackColor = Fuchsia.copy(alpha = 0.15f),
                strokeWidth = 3.dp,
                modifier = Modifier.size(size),
            )
        }
    }
}
