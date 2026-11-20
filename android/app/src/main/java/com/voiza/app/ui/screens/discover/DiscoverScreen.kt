package com.voiza.app.ui.screens.discover

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Explore
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.RoomCategory
import com.voiza.app.domain.model.RoomSort
import com.voiza.app.ui.components.EmptyState
import com.voiza.app.ui.components.RoomGridSkeleton
import com.voiza.app.ui.screens.home.RoomCard
import com.voiza.app.ui.screens.home.voizaChipColors
import com.voiza.app.ui.screens.home.voizaFieldColors
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VoizaBackground
import com.voiza.app.ui.util.label
import com.voiza.app.viewmodel.HomeViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory
import kotlinx.coroutines.delay

/**
 * Discover: the full-reach search surface. Unlike the lobby's quick row, the
 * query box is permanent and every keystroke is debounced into
 * `GET /api/rooms?search=...` — the server answers across all open rooms, so a
 * room ranked 200th is still findable here. Category and sort ride the same
 * request. Reuses HomeViewModel's fetch logic (own instance) rather than a
 * second network path.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun DiscoverScreen(
    onBack: () -> Unit,
    onOpenRoom: (String) -> Unit,
    viewModel: HomeViewModel = viewModel(factory = voizaViewModelFactory { HomeViewModel() }),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var query by remember { mutableStateOf("") }

    // Debounce: one request per pause in typing, not one per keystroke.
    LaunchedEffect(query) {
        delay(400)
        if (query.trim() != state.search.trim()) viewModel.setSearch(query.trim())
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(VoizaBackground)
            .statusBarsPadding(),
    ) {
        // Top bar
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 10.dp),
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.Default.ArrowBack, contentDescription = "Back", tint = OnDarkHigh)
            }
            Text(
                text = "Discover",
                color = OnDarkHigh,
                fontSize = 20.sp,
                fontWeight = FontWeight.Bold,
            )
        }

        // Search field
        OutlinedTextField(
            value = query,
            onValueChange = { query = it.take(60) },
            placeholder = { Text("Search rooms, hosts\u2026", fontSize = 13.sp) },
            leadingIcon = { Icon(Icons.Default.Search, contentDescription = null, tint = OnDarkMedium) },
            trailingIcon = {
                if (query.isNotEmpty()) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "Clear search",
                        tint = OnDarkMedium,
                        modifier = Modifier
                            .padding(8.dp)
                            .size(18.dp)
                            .clickable(onClick = { query = "" }),
                    )
                }
            },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { viewModel.setSearch(query.trim()) }),
            colors = voizaFieldColors(),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp),
        )

        // Category chips — every category the server accepts, not just the lobby's three.
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 14.dp, vertical = 8.dp),
        ) {
            RoomCategory.entries.forEach { category ->
                FilterChip(
                    selected = state.category == category && !state.showingMyRooms,
                    onClick = { viewModel.selectCategory(category) },
                    label = { Text(category.label(), fontSize = 12.sp) },
                    colors = voizaChipColors(),
                )
            }
        }

        // Sort chips
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 14.dp),
        ) {
            RoomSort.entries.forEach { option ->
                FilterChip(
                    selected = state.sort == option,
                    onClick = { viewModel.selectSort(option) },
                    label = { Text(option.label, fontSize = 12.sp) },
                    colors = voizaChipColors(),
                )
            }
        }

        Spacer(Modifier.height(6.dp))

        when {
            state.loading && state.rooms.isEmpty() -> RoomGridSkeleton(
                count = 6,
                modifier = Modifier.padding(horizontal = 14.dp),
            )

            state.error != null && state.rooms.isEmpty() -> EmptyState(
                icon = Icons.Default.Explore,
                title = state.error ?: "Could not load rooms",
                subtitle = "Pull down to try again",
            )

            state.rooms.isEmpty() && query.isNotBlank() -> EmptyState(
                icon = Icons.Default.Search,
                title = "Nothing matches \"${query.trim()}\"",
                subtitle = "The server searched every open room it knows about",
            )

            state.rooms.isEmpty() -> EmptyState(
                icon = Icons.Default.Explore,
                title = "No rooms here yet",
                subtitle = "Try another category, or open your own room",
            )

            else -> PullToRefreshBox(
                isRefreshing = state.refreshing,
                onRefresh = viewModel::refresh,
            ) {
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(minSize = 160.dp),
                    contentPadding = PaddingValues(14.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(state.rooms, key = { it.id }) { room ->
                        RoomCard(room = room, onClick = { onOpenRoom(room.id) })
                    }
                }
            }
        }
    }
}
