package com.voiza.app.ui.screens.home

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.VoizaSurfaceHigh

/**
 * Dark-theme colours shared by the lobby's search box and the room form, so a text field looks
 * the same wherever the host meets it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun voizaFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Cyan,
    unfocusedBorderColor = Color(0xFF3D3670),
    focusedLabelColor = Cyan,
    unfocusedLabelColor = OnDarkMedium,
    cursorColor = Fuchsia,
    focusedTextColor = OnDarkHigh,
    unfocusedTextColor = OnDarkHigh,
)

@Composable
internal fun voizaChipColors() = FilterChipDefaults.filterChipColors(
    selectedContainerColor = VoizaSurfaceHigh,
    selectedLabelColor = OnDarkHigh,
    containerColor = Color.Transparent,
    labelColor = OnDarkMedium,
)
