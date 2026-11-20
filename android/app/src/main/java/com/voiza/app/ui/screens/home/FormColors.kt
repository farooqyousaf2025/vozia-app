package com.voiza.app.ui.screens.home

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.VoizaOutline
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.Violet

/**
 * Dark-theme colours shared by the lobby's search box, the Discover field and
 * the room form, so a text field looks the same wherever the host meets it.
 * Focus is royal purple — gold never marks an ordinary input.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun voizaFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Violet,
    unfocusedBorderColor = VoizaOutline,
    focusedLabelColor = Violet,
    unfocusedLabelColor = OnDarkMedium,
    cursorColor = Violet,
    focusedTextColor = OnDarkHigh,
    unfocusedTextColor = OnDarkHigh,
    focusedContainerColor = Color.Transparent,
    unfocusedContainerColor = Color.Transparent,
)

@Composable
internal fun voizaChipColors() = FilterChipDefaults.filterChipColors(
    selectedContainerColor = Violet.copy(alpha = 0.24f),
    selectedLabelColor = OnDarkHigh,
    containerColor = VoizaSurfaceHigh,
    labelColor = OnDarkMedium,
)
