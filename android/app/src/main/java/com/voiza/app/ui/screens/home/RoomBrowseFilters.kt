package com.voiza.app.ui.screens.home

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.RoomCategory
import com.voiza.app.domain.model.RoomSort
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.util.label

/**
 * One browse-filter layout shared by Home and Discover. Section titles make
 * category selection distinct from result ordering (Popular rooms vs Most popular).
 */
@Composable
fun RoomBrowseFilters(
    category: RoomCategory,
    sort: RoomSort,
    region: String?,
    accountRegion: String?,
    showingMyRooms: Boolean,
    onSelectCategory: (RoomCategory) -> Unit,
    onSelectSort: (RoomSort) -> Unit,
    onSelectRegion: (String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        Text(
            text = "Categories",
            color = OnDarkMedium,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(top = 6.dp),
        ) {
            RoomCategory.entries.forEach { option ->
                FilterChip(
                    selected = category == option && !showingMyRooms,
                    onClick = { onSelectCategory(option) },
                    label = { Text(option.label(), fontSize = 12.sp) },
                    colors = voizaChipColors(),
                )
            }
        }

        if (!showingMyRooms) {
            Text(
                text = "Sort by",
                color = OnDarkMedium,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(top = 4.dp),
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(top = 6.dp),
            ) {
                RoomSort.entries.forEach { option ->
                    FilterChip(
                        selected = sort == option,
                        onClick = { onSelectSort(option) },
                        label = { Text(option.label, fontSize = 12.sp) },
                        colors = voizaChipColors(),
                    )
                }
            }

            val country = accountRegion
                ?.uppercase()
                ?.takeIf { it.matches(Regex("[A-Z]{2}")) }
            if (country != null) {
                Text(
                    text = "Region",
                    color = OnDarkMedium,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(top = 4.dp),
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(top = 6.dp),
                ) {
                    FilterChip(
                        selected = region == null,
                        onClick = { onSelectRegion(null) },
                        label = { Text("Global", fontSize = 12.sp) },
                        colors = voizaChipColors(),
                    )
                    FilterChip(
                        selected = region == country,
                        onClick = { onSelectRegion(country) },
                        label = { Text("Region · $country", fontSize = 12.sp) },
                        colors = voizaChipColors(),
                    )
                }
            }
        }
    }
}
