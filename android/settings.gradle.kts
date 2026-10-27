pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        // LiveKit Android and Socket.IO java client are published on Maven Central.
        mavenCentral()
        // livekit-android depends on audioswitch, which is only on JitPack.
        maven { url = uri("https://jitpack.io") }
    }
}

rootProject.name = "Voiza"
include(":app")
