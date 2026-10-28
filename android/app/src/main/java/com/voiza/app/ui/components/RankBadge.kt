package com.voiza.app.ui.components

import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import coil.compose.AsyncImage
import com.voiza.app.domain.model.UserRank

/**
 * The rung a member earned, painted as the admin panel configured it.
 *
 * Nothing is derived here: name, artwork and tint all come from the server's
 * resolution of `users.xp` against `rank_levels`. A payload that carried no
 * rank renders nothing rather than "level 0" — the client cannot tell an
 * omitted field from a newcomer, and guessing would mint a badge.
 */
@Composable
fun RankBadge(
    rank: UserRank?,
    size: Dp,
    modifier: Modifier = Modifier,
) {
    val url = rank?.badge.asAssetUrl()
    if (rank == null || url == null) return
    AsyncImage(
        model = url,
        contentDescription = "${rank.name} badge",
        contentScale = ContentScale.Fit,
        modifier = modifier.size(size),
    )
}
