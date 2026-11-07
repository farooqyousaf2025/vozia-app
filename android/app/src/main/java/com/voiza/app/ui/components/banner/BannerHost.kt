package com.voiza.app.ui.components.banner

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.staticCompositionLocalOf
import com.voiza.app.domain.model.BannerScreen
import com.voiza.app.domain.model.BannerTarget
import com.voiza.app.domain.usecase.BannersStore
import com.voiza.app.ui.navigation.Routes

/**
 * The live campaigns, handed to whatever surface draws one.
 *
 * A CompositionLocal rather than a parameter on four screens because the list belongs to the process,
 * not to a route: Home, the gift panel and the game desk each load their own state already, and
 * threading a fifth argument through all of them to pass the same object would be the app pretending
 * a banner is a room resource. Nothing in `ui/` reads `ServiceLocator` directly, so this is where the
 * store crosses into composition.
 */
val LocalBannerStore = staticCompositionLocalOf<BannersStore?> { null }

/** Where a banner tap goes. Provided beside [LocalBannerStore] by the activity that owns the graph. */
val LocalBannerNavigator = staticCompositionLocalOf<BannerNavigator?> { null }

/**
 * Runs the verb a banner names.
 *
 * The app never turns a stored string into a route by guessing: the server sends `ctaType` with
 * `ctaValue`, this class maps the four internal screen names onto the route table it already has, and
 * anything it cannot name was dropped in the mapper long before it reached here.
 */
class BannerNavigator(
    private val context: Context,
    private val navigate: (String) -> Unit,
) {

    /** False when the tap went nowhere, which the caller may count but cannot fix. */
    fun open(target: BannerTarget): Boolean = when (target) {
        BannerTarget.None -> false
        is BannerTarget.Internal -> {
            navigate(routeFor(target.screen))
            true
        }
        // A banner that names a room opens it the same way a room card on Home does, so the join,
        // the password prompt and the seat rules all stay the room's own.
        is BannerTarget.Room -> {
            navigate(Routes.room(target.roomId))
            true
        }
        is BannerTarget.Link -> openExternal(target.url)
    }

    private fun routeFor(screen: BannerScreen): String = when (screen) {
        BannerScreen.HOME -> Routes.HOME
        BannerScreen.STORE -> Routes.STORE
        BannerScreen.WALLET -> Routes.WALLET
        BannerScreen.PROFILE -> Routes.PROFILE
    }

    /**
     * Out of the app, through whatever the device has for a web link.
     *
     * Only ever an `https` URL: the mapper refuses anything else, and so does the database CHECK
     * behind it, because a banner is content an operator typed and this is the one action that leaves
     * the platform's own surface. A device with no browser gets silence — the tap is still counted,
     * and there is no second place to send a member who has nowhere to go.
     */
    private fun openExternal(url: String): Boolean = try {
        context.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        true
    } catch (error: ActivityNotFoundException) {
        false
    }
}
