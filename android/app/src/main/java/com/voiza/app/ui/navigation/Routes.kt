package com.voiza.app.ui.navigation

object Routes {
    const val AUTH = "auth"
    const val HOME = "home"
    const val CREATE_ROOM = "createRoom"
    const val WALLET = "wallet"
    const val PROFILE = "profile"
    const val STORE = "store"
    const val QUESTS = "quests"

    const val ROOM_ARG = "roomId"
    const val ROOM_BASE = "room"
    const val ROOM_PATTERN = "$ROOM_BASE/{$ROOM_ARG}"

    // The host's edit form. Reused route of CreateRoomScreen, keyed by the room id so the
    // profile always comes from the server rather than from whichever row was tapped.
    const val EDIT_ROOM_BASE = "editRoom"
    const val EDIT_ROOM_PATTERN = "$EDIT_ROOM_BASE/{$ROOM_ARG}"

    const val SESSION_ARG = "sessionId"

    // Become a Partner. The role travels as the server's own constant, so a role added in the
    // backend reaches the form renderer as another value rather than as something this APK cannot name.
    const val PARTNER = "partner"
    const val PARTNER_APPLICATIONS = "partnerApplications"
    const val PARTNER_ROLE_ARG = "role"
    const val PARTNER_APPLY_BASE = "partnerApply"
    const val PARTNER_APPLY_PATTERN = "$PARTNER_APPLY_BASE/{$PARTNER_ROLE_ARG}"

    // Nested under the room path so opening the desk never pops the room entry, which
    // keeps PartyRoomViewModel (and the LiveKit voice connection it owns) alive.
    const val GAME_LOBBY_PATTERN = "$ROOM_PATTERN/games"
    const val GAME_PATTERN = "game/{$SESSION_ARG}"

    // Same nesting for the PK desk: leaving it returns to the room still connected.
    const val PK_PATTERN = "$ROOM_PATTERN/pk"

    fun room(roomId: String) = "$ROOM_BASE/$roomId"

    fun editRoom(roomId: String) = "$EDIT_ROOM_BASE/$roomId"

    fun gameLobby(roomId: String) = "$ROOM_BASE/$roomId/games"

    fun pk(roomId: String) = "$ROOM_BASE/$roomId/pk"

    fun game(sessionId: String) = "game/$sessionId"

    fun partnerApply(role: String) = "$PARTNER_APPLY_BASE/$role"
}
