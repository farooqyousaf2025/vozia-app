package com.voiza.app

import android.app.Application
import android.os.Build
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.decode.GifDecoder
import coil.decode.ImageDecoderDecoder
import com.voiza.app.di.ServiceLocator

/**
 * Boots the hand-written DI container and owns the one image loader every `AsyncImage` in the app
 * uses. Keeping this eager (no Hilt component tree) is deliberate — see android/README.md.
 */
class VoizaApp : Application(), ImageLoaderFactory {

    override fun onCreate() {
        super.onCreate()
        ServiceLocator.init(this)
    }

    /**
     * Coil's default loader decodes the first frame of an animated GIF or WebP and stops there, which
     * is invisible until something is supposed to move: a promotional banner uploaded as a GIF, an
     * operator's animated avatar frame. The two decoders below are what make a moving file move.
     *
     * `ImageDecoderDecoder` is the platform decoder (Android 9+) and handles animated WebP as well as
     * GIF; `GifDecoder` is Coil's own and covers GIF only, which is all the older releases can be
     * given without another dependency.
     */
    override fun newImageLoader(): ImageLoader = ImageLoader.Builder(this)
        .components {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                add(ImageDecoderDecoder.Factory())
            } else {
                add(GifDecoder.Factory())
            }
        }
        .build()
}
