package com.voiza.app.ui.navigation

object Routes {
    const val AUTH = "auth"
    const val HOME = "home"
    const val CREATE_ROOM = "createRoom"
    const val WALLET = "wallet"
    const val PROFILE = "profile"

    const val ROOM_ARG = "roomId"
    const val ROOM_BASE = "room"
    const val ROOM_PATTERN = "$ROOM_BASE/{$ROOM_ARG}"

    // The host's edit form. Reused route of CreateRoomScreen, keyed by the room id so the
    // profile always comes from the server rather than from whichever row was tapped.
    const val EDIT_ROOM_BASE = "editRoom"
    const val EDIT_ROOM_PATTERN = "$EDIT_ROOM_BASE/{$ROOM_ARG}"

    const val SESSION_ARG = "sessionId"

    // Nested under the room path so opening the desk never pops the room entry, which
    // keeps PartyRoomViewModel (and the LiveKit voice connection it owns) alive.
    const val GAME_LOBBY_PATTERN = "$ROOM_PATTERN/games"
    const val GAME_PATTERN = "game/{$SESSION_ARG}"

    fun room(roomId: String) = "$ROOM_BASE/$roomId"

    fun editRoom(roomId: String) = "$EDIT_ROOM_BASE/$roomId"

    fun gameLobby(roomId: String) = "$ROOM_BASE/$roomId/games"

    fun game(sessionId: String) = "game/$sessionId"
}
