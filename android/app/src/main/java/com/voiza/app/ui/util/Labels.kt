package com.voiza.app.ui.util

import com.voiza.app.domain.model.RoomCategory

/** Human labels for room categories (tabs, chips, dialogs). */
fun RoomCategory.label(): String = when (this) {
    RoomCategory.POPULAR -> "Popular"
    RoomCategory.PARTY -> "Party"
    RoomCategory.MUSIC -> "Music"
    RoomCategory.GAME -> "Game"
    RoomCategory.CHAT -> "Chat"
}
