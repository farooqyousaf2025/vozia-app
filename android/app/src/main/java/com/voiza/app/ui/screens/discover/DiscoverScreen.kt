package com.voiza.app.ui.screens.discover

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Explore
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.voiza.app.ui.components.EmptyState
import com.voiza.app.ui.components.RoomGridSkeleton
import com.voiza.app.ui.components.VoizaBottomBar
import com.voiza.app.ui.components.VoizaNavTab
import com.voiza.app.ui.screens.home.RoomBrowseFilters
import com.voiza.app.ui.screens.home.RoomCard
import com.voiza.app.ui.screens.home.voizaFieldColors
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.VoizaBackground
import com.voiza.app.viewmodel.HomeViewModel
import kotlinx.coroutines.delay

/**
 * Discover is the full-reach version of the Home lobby. It shares Home's
 * filters and category/sort/region controls, while retaining full search.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun DiscoverScreen(
    onBack: () -> Unit,
    onHome: () -> Unit,
    onCreateRoom: () -> Unit,
    onOpenMessages: () -> Unit,
    onOpenProfile: () -> Unit,
    onOpenRoom: (String) -> Unit,
    viewModel: HomeViewModel,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var query by remember(state.search) { mutableStateOf(state.search) }

    LaunchedEffect(viewModel) {
        viewModel.showAllRooms()
    }

    // Debounce: one request per pause in typing, not one per keystroke.
    LaunchedEffect(query) {
        delay(400)
        if (query.trim() != state.search.trim()) viewModel.setSearch(query.trim())
    }

    Scaffold(
        containerColor = VoizaBackground,
        bottomBar = {
            VoizaBottomBar(
                current = VoizaNavTab.DISCOVER,
                onHome = onHome,
                onDiscover = {},
                onCreateRoom = onCreateRoom,
                onMessages = onOpenMessages,
                onProfile = onOpenProfile,
            )
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(VoizaBackground)
                .padding(innerPadding)
                .statusBarsPadding(),
        ) {
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

            OutlinedTextField(
                value = query,
                onValueChange = { query = it.take(60) },
                placeholder = { Text("Search rooms, hosts…", fontSize = 13.sp) },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null, tint = OnDarkMedium) },
                trailingIcon = {
                    if (query.isNotEmpty()) {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = "Clear search",
                            tint = OnDarkMedium,
                            modifier = Modifier
                                .padding(8.dp)
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

            RoomBrowseFilters(
                category = state.category,
                sort = state.sort,
                region = state.region,
                accountRegion = state.user?.countryCode,
                showingMyRooms = state.showingMyRooms,
                onSelectCategory = viewModel::selectCategory,
                onSelectSort = viewModel::selectSort,
                onSelectRegion = viewModel::selectRegion,
            )

            Spacer(Modifier.height(6.dp))

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                PullToRefreshBox(
                    isRefreshing = state.refreshing,
                    onRefresh = viewModel::refresh,
                    modifier = Modifier.fillMaxSize(),
                ) {
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

                        else -> LazyVerticalGrid(
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
    }
}
