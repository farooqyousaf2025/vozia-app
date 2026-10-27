package com.voiza.app

import android.app.Application
import com.voiza.app.di.ServiceLocator

/**
 * Boots the hand-written DI container. Keeping this eager (no Hilt component
 * tree) is deliberate — see android/README.md.
 */
class VoizaApp : Application() {

    override fun onCreate() {
        super.onCreate()
        ServiceLocator.init(this)
    }
}
