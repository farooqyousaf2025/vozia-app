package com.voiza.app.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.voiza.app.ui.screens.agency.AgencyDashboardScreen
import com.voiza.app.ui.screens.auth.AuthScreen
import com.voiza.app.ui.screens.discover.DiscoverScreen
import com.voiza.app.ui.screens.game.GameLobbyScreen
import com.voiza.app.ui.screens.game.GameScreen
import com.voiza.app.ui.screens.friends.FriendsScreen
import com.voiza.app.ui.screens.home.CreateRoomScreen
import com.voiza.app.ui.screens.home.HomeScreen
import com.voiza.app.ui.screens.marketplace.MarketplaceScreen
import com.voiza.app.ui.screens.pk.PkScreen
import com.voiza.app.ui.screens.partner.BecomePartnerScreen
import com.voiza.app.ui.screens.partner.MyApplicationsScreen
import com.voiza.app.ui.screens.partner.PartnerApplyScreen
import com.voiza.app.ui.screens.partner.PartnerDeskScreen
import com.voiza.app.ui.screens.profile.ProfileScreen
import com.voiza.app.ui.screens.quests.QuestsScreen
import com.voiza.app.ui.screens.rankings.RankingsScreen
import com.voiza.app.ui.screens.room.PartyRoomScreen
import com.voiza.app.ui.screens.store.StoreScreen
import com.voiza.app.ui.screens.wallet.WalletScreen
import com.voiza.app.viewmodel.FriendsTab

/**
 * App graph. Start destination is decided by MainActivity from the persisted
 * session; `auth` pops itself off the stack after login, and leaving a room
 * returns to `home` underneath.
 */
@Composable
fun VoizaNavHost(
    startOnHome: Boolean,
    onLogout: () -> Unit,
    navController: NavHostController = rememberNavController(),
) {
    NavHost(
        navController = navController,
        startDestination = if (startOnHome) Routes.HOME else Routes.AUTH,
    ) {
        composable(Routes.AUTH) {
            AuthScreen(
                onLoggedIn = {
                    navController.navigate(Routes.HOME) {
                        popUpTo(Routes.AUTH) { inclusive = true }
                    }
                },
            )
        }

        composable(Routes.HOME) {
            HomeScreen(
                onOpenRoom = { roomId -> navController.navigate(Routes.room(roomId)) },
                onCreateRoom = { navController.navigate(Routes.CREATE_ROOM) },
                onOpenWallet = { navController.navigate(Routes.WALLET) },
                onOpenStore = { navController.navigate(Routes.STORE) },
                onOpenProfile = { navController.navigate(Routes.PROFILE) },
                onOpenRankings = { navController.navigate(Routes.RANKINGS) },
                onOpenDiscover = { navController.navigate(Routes.DISCOVER) },
                onOpenMessages = { navController.navigate(Routes.MESSAGES) },
            )
        }

        // The shell's Discover tab. Pushed rather than swapped so the lobby's
        // state (and the room under it, if any) survives the visit.
        composable(Routes.DISCOVER) {
            DiscoverScreen(
                onBack = { navController.popBackStack() },
                onOpenRoom = { roomId -> navController.navigate(Routes.room(roomId)) },
            )
        }

        // The shell's Messages tab: friends route with the conversation pane preselected.
        composable(Routes.MESSAGES) {
            FriendsScreen(
                onBack = { navController.popBackStack() },
                initialTab = FriendsTab.MESSAGES,
            )
        }

        composable(Routes.CREATE_ROOM) {
            CreateRoomScreen(
                onBack = { navController.popBackStack() },
                onRoomCreated = { roomId ->
                    navController.navigate(Routes.room(roomId)) {
                        popUpTo(Routes.HOME)
                    }
                },
            )
        }

        // Same form, edit mode: it loads GET /api/rooms/:id and saves through PATCH.
        composable(
            route = Routes.EDIT_ROOM_PATTERN,
            arguments = listOf(navArgument(Routes.ROOM_ARG) { type = NavType.StringType }),
        ) { entry ->
            CreateRoomScreen(
                onBack = { navController.popBackStack() },
                onRoomCreated = { navController.popBackStack() },
                editRoomId = entry.arguments?.getString(Routes.ROOM_ARG).orEmpty(),
            )
        }

        composable(
            route = Routes.ROOM_PATTERN,
            arguments = listOf(navArgument(Routes.ROOM_ARG) { type = NavType.StringType }),
        ) { entry ->
            val roomId = entry.arguments?.getString(Routes.ROOM_ARG).orEmpty()
            PartyRoomScreen(
                roomId = roomId,
                onLeaveRoom = { navController.popBackStack() },
                onOpenGames = { navController.navigate(Routes.gameLobby(roomId)) },
                onOpenPk = { navController.navigate(Routes.pk(roomId)) },
                onEditRoom = { navController.navigate(Routes.editRoom(roomId)) },
            )
        }

        // Child of the room route, like the game desk: the voice connection stays alive.
        composable(
            route = Routes.PK_PATTERN,
            arguments = listOf(navArgument(Routes.ROOM_ARG) { type = NavType.StringType }),
        ) { entry ->
            PkScreen(
                roomId = entry.arguments?.getString(Routes.ROOM_ARG).orEmpty(),
                onBack = { navController.popBackStack() },
            )
        }

        // Child of the room route: the room entry stays on the stack, so the voice
        // connection owned by PartyRoomViewModel is never torn down by a visit here.
        composable(
            route = Routes.GAME_LOBBY_PATTERN,
            arguments = listOf(navArgument(Routes.ROOM_ARG) { type = NavType.StringType }),
        ) { entry ->
            val roomId = entry.arguments?.getString(Routes.ROOM_ARG).orEmpty()
            GameLobbyScreen(
                roomId = roomId,
                onBack = { navController.popBackStack() },
                onOpenSession = { sessionId -> navController.navigate(Routes.game(sessionId)) },
                onOpenWallet = { navController.navigate(Routes.WALLET) },
            )
        }

        composable(
            route = Routes.GAME_PATTERN,
            arguments = listOf(navArgument(Routes.SESSION_ARG) { type = NavType.StringType }),
        ) { entry ->
            val sessionId = entry.arguments?.getString(Routes.SESSION_ARG).orEmpty()
            GameScreen(
                sessionId = sessionId,
                onBack = { navController.popBackStack() },
                onOpenWallet = { navController.navigate(Routes.WALLET) },
            )
        }

        composable(Routes.WALLET) {
            WalletScreen(
                onBack = { navController.popBackStack() },
                onOpenPartnerApply = { role -> navController.navigate(Routes.partnerApply(role)) },
                onOpenMarketplace = { navController.navigate(Routes.MARKETPLACE) },
            )
        }

        composable(Routes.MARKETPLACE) {
            MarketplaceScreen(onBack = { navController.popBackStack() })
        }

        composable(Routes.PARTNER) {
            BecomePartnerScreen(
                onBack = { navController.popBackStack() },
                onOpenRole = { role -> navController.navigate(Routes.partnerApply(role)) },
                onOpenMyApplications = { navController.navigate(Routes.PARTNER_APPLICATIONS) },
            )
        }

        composable(Routes.PARTNER_APPLICATIONS) {
            MyApplicationsScreen(
                onBack = { navController.popBackStack() },
                onOpenRole = { role -> navController.navigate(Routes.partnerApply(role)) },
            )
        }

        // The one form for all four roles: it renders whatever spec the server returns for this role.
        composable(
            route = Routes.PARTNER_APPLY_PATTERN,
            arguments = listOf(navArgument(Routes.PARTNER_ROLE_ARG) { type = NavType.StringType }),
        ) { entry ->
            PartnerApplyScreen(
                role = entry.arguments?.getString(Routes.PARTNER_ROLE_ARG).orEmpty(),
                onBack = { navController.popBackStack() },
            )
        }

        // The agency's own book. Master and sub are the same route: the server's position answer
        // decides which sections exist, and a member who runs nothing is shown the server's refusal.
        composable(Routes.AGENCY) {
            AgencyDashboardScreen(onBack = { navController.popBackStack() })
        }

        // The seller/BD desk. Seller and BD are the same route: the server's whoami answer decides
        // which sections exist, and a member who runs no active account is shown the server's refusal.
        composable(Routes.PARTNER_DESK) {
            PartnerDeskScreen(onBack = { navController.popBackStack() })
        }

        composable(Routes.STORE) {
            StoreScreen(
                onBack = { navController.popBackStack() },
                onOpenWallet = { navController.navigate(Routes.WALLET) },
            )
        }

        composable(Routes.QUESTS) {
            QuestsScreen(onBack = { navController.popBackStack() })
        }

        composable(Routes.FRIENDS) {
            FriendsScreen(onBack = { navController.popBackStack() })
        }

        composable(Routes.RANKINGS) {
            RankingsScreen(
                onBack = { navController.popBackStack() },
                onOpenRoom = { roomId -> navController.navigate(Routes.room(roomId)) },
            )
        }

        composable(Routes.PROFILE) {
            ProfileScreen(
                onBack = { navController.popBackStack() },
                onOpenWallet = { navController.navigate(Routes.WALLET) },
                onOpenFriends = { navController.navigate(Routes.FRIENDS) },
                onOpenStore = { navController.navigate(Routes.STORE) },
                onOpenQuests = { navController.navigate(Routes.QUESTS) },
                onOpenPartner = { navController.navigate(Routes.PARTNER) },
                onOpenAgency = { navController.navigate(Routes.AGENCY) },
                onOpenPartnerDesk = { navController.navigate(Routes.PARTNER_DESK) },
                onLoggedOut = {
                    navController.navigate(Routes.AUTH) {
                        popUpTo(0) { inclusive = true }
                    }
                    onLogout()
                },
            )
        }
    }
}
