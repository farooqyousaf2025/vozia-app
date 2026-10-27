package com.voiza.app.ui.screens.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.RoomCategory
import com.voiza.app.ui.components.DangerButton
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.util.label
import com.voiza.app.viewmodel.HomeViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * Room form, in two modes. With no [editRoomId] it creates: title, category chips, public/private
 * + password, and a seat slider whose range and default come from `GET /api/rooms/capacity` — the
 * administrator's policy, not a number this build knows. With an [editRoomId] it is filled from
 * `GET /api/rooms/:id` and saves through `PATCH`; access type, password and seat count then
 * disappear, because the edit endpoint does not accept them.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreateRoomScreen(
    onBack: () -> Unit,
    onRoomCreated: (String) -> Unit,
    editRoomId: String? = null,
    viewModel: HomeViewModel = viewModel(
        factory = voizaViewModelFactory { HomeViewModel() },
    ),
) {
    val state by viewModel.state.collectAsState()

    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var category by remember { mutableStateOf(RoomCategory.PARTY) }
    var isPrivate by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    var language by remember { mutableStateOf("") }
    var region by remember { mutableStateOf("") }
    var rules by remember { mutableStateOf("") }
    // Null while the host has not chosen: the room then gets the server's default capacity.
    var capacity by remember { mutableStateOf<Float?>(null) }
    val seatPolicy = state.seatPolicy
    val editing = editRoomId != null

    LaunchedEffect(editRoomId) {
        editRoomId?.let { viewModel.loadRoomForEdit(it) }
    }

    // Prefill from the server's copy of the room, so a stale lobby row cannot be written back.
    LaunchedEffect(state.editingRoom) {
        state.editingRoom?.let { room ->
            title = room.title
            description = room.description.orEmpty()
            category = room.category
            language = room.language.orEmpty()
            region = room.region.orEmpty()
            rules = room.rules.orEmpty()
        }
    }

    // One-shot navigation when the create call resolves.
    state.createdRoomId?.let { roomId ->
        viewModel.consumedCreatedRoom()
        onRoomCreated(roomId)
    }

    if (editing) {
        state.savedRoomId?.let {
            viewModel.consumedSavedRoom()
            onBack()
        }
    }

    if (editing && state.editingRoom == null) {
        // Nothing to type into until the server's copy arrives; a refusal is shown as-is.
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background)
                .padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            LoadingProgress(overlay = false)
            state.editError?.let {
                Spacer(Modifier.height(10.dp))
                Text(it, color = DangerRed, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        return
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = OnDarkHigh)
            }
            Text(
                text = if (editing) "Edit room" else "Open a room",
                color = OnDarkHigh,
                fontSize = 20.sp,
                fontWeight = FontWeight.Bold,
            )
        }
        Spacer(Modifier.height(18.dp))

        SectionLabel("Title")
        OutlinedTextField(
            value = title,
            onValueChange = { title = it.take(60) },
            placeholder = { Text("Friday night party", fontSize = 14.sp) },
            singleLine = true,
            colors = voizaFieldColors(),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = "${title.length.coerceAtMost(60)}/60",
            color = OnDarkMedium,
            fontSize = 11.sp,
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(12.dp))
        SectionLabel("Description (optional)")
        OutlinedTextField(
            value = description,
            onValueChange = { description = it.take(200) },
            placeholder = { Text("What is this room about?", fontSize = 14.sp) },
            minLines = 2,
            colors = voizaFieldColors(),
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(16.dp))
        SectionLabel("Category")
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.horizontalScroll(rememberScrollState()),
        ) {
            RoomCategory.entries.forEach { cat ->
                FilterChip(
                    selected = category == cat,
                    onClick = { category = cat },
                    label = { Text(cat.label(), fontSize = 13.sp) },
                    colors = voizaChipColors(),
                )
            }
        }

        Spacer(Modifier.height(16.dp))
        SectionLabel("Language and region (optional)")
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(
                value = language,
                onValueChange = { language = it.take(16) },
                placeholder = { Text("en", fontSize = 14.sp) },
                label = { Text("Language", fontSize = 12.sp) },
                singleLine = true,
                colors = voizaFieldColors(),
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = region,
                onValueChange = { region = it.uppercase().take(2) },
                placeholder = { Text("US", fontSize = 14.sp) },
                label = { Text("Region", fontSize = 12.sp) },
                singleLine = true,
                colors = voizaFieldColors(),
                modifier = Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(6.dp))
        Text(
            text = "Short tags the lobby filters on \u2014 'en', 'BD'. A malformed tag is refused by the server, not quietly stored.",
            color = OnDarkMedium,
            fontSize = 11.sp,
        )

        Spacer(Modifier.height(14.dp))
        SectionLabel("House rules (optional)")
        OutlinedTextField(
            value = rules,
            onValueChange = { rules = it.take(1000) },
            placeholder = { Text("Be kind, no spam, mic off when not on the seat", fontSize = 14.sp) },
            minLines = 3,
            colors = voizaFieldColors(),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = "${rules.length.coerceAtMost(1000)}/1000 \u2014 every member sees this in the room",
            color = OnDarkMedium,
            fontSize = 11.sp,
        )

        if (!editing) {
            Spacer(Modifier.height(16.dp))
            SectionLabel("Access")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(
                    selected = !isPrivate,
                    onClick = { isPrivate = false },
                    label = { Text("Public", fontSize = 13.sp) },
                    colors = voizaChipColors(),
                )
                FilterChip(
                    selected = isPrivate,
                    onClick = { isPrivate = true },
                    label = { Text("Private", fontSize = 13.sp) },
                    colors = voizaChipColors(),
                )
            }
            if (isPrivate) {
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it.take(16) },
                    label = { Text("Room password", fontSize = 13.sp) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
                    colors = voizaFieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            Spacer(Modifier.height(16.dp))
            SectionLabel(
                if (seatPolicy == null) "Seats \u2014 platform default"
                else "Seats \u2014 ${(capacity ?: seatPolicy.defaultSeats).toInt()}",
            )
            if (seatPolicy == null) {
                // No policy read yet, so no range to offer. The server's default still makes a room.
                Text(
                    text = "The platform decides how many seats a new room gets; this build does not guess one.",
                    color = OnDarkMedium,
                    fontSize = 11.sp,
                )
            } else {
                val shown = (capacity ?: seatPolicy.defaultSeats.toFloat())
                    .coerceIn(seatPolicy.minSeats.toFloat(), seatPolicy.maxSeats.toFloat())
                Slider(
                    value = shown,
                    onValueChange = { capacity = it },
                    valueRange = seatPolicy.minSeats.toFloat()..seatPolicy.maxSeats.toFloat(),
                    steps = (seatPolicy.maxSeats - seatPolicy.minSeats - 1).coerceAtLeast(0),
                    colors = sliderColors(),
                )
            }
            Text(
                text = "Seat 0 is yours (host); the rest are speaker slots.",
                color = OnDarkMedium,
                fontSize = 11.sp,
            )
        } else {
            Spacer(Modifier.height(14.dp))
            Text(
                text = "Seats, access and password are set when the room opens \u2014 editing them here is not offered, " +
                    "because the server does not accept that change.",
                color = OnDarkMedium,
                fontSize = 11.sp,
            )
        }

        val failure = if (editing) state.editError else state.createError
        failure?.let {
            Spacer(Modifier.height(12.dp))
            Text(it, color = DangerRed, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        }

        Spacer(Modifier.height(24.dp))
        VoizaButton(
            text = when {
                state.creatingRoom || state.savingRoom -> "Saving\u2026"
                editing -> "Save changes"
                else -> "Create & enter"
            },
            onClick = {
                val target = editRoomId
                if (target != null) {
                    viewModel.saveRoom(
                        roomId = target,
                        title = title,
                        description = description,
                        category = category,
                        language = language,
                        region = region,
                        rules = rules,
                    )
                } else {
                    viewModel.createRoom(
                        title = title,
                        description = description,
                        category = category,
                        isPrivate = isPrivate,
                        password = password,
                        seatCapacity = capacity?.toInt(),
                        language = language,
                        region = region,
                        rules = rules,
                    )
                }
            },
            enabled = !state.creatingRoom && !state.savingRoom,
            modifier = Modifier.fillMaxWidth(),
        )

        if (editing) {
            Spacer(Modifier.height(14.dp))
            DangerButton(
                text = "Delete this room",
                onClick = { editRoomId?.let { viewModel.deleteRoom(it) } },
                enabled = !state.savingRoom,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = "A room somebody stood in, or money moved through, stays as history. Closing it is the way to stop it.",
                color = OnDarkMedium,
                fontSize = 11.sp,
            )
        }
        Spacer(Modifier.height(30.dp))
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        color = OnDarkHigh,
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(bottom = 6.dp),
    )
}

@Composable
private fun sliderColors() = SliderDefaults.colors(
    thumbColor = Fuchsia,
    activeTrackColor = Cyan,
    inactiveTrackColor = VoizaSurfaceHigh,
)
