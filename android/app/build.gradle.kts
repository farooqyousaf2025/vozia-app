import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ---------------------------------------------------------------------------
// BuildConfig value resolution: gradle property -> env var -> emulator default
// ---------------------------------------------------------------------------
fun prop(name: String, default: String): String {
    return (
        providers.gradleProperty(name).orNull
            ?: providers.environmentVariable(name).orNull
            ?: default
        )
}

// ---------------------------------------------------------------------------
// Release signing. Keys never live in the repo: `android/keystore.properties`
// (git ignored) supplies them, optionally relocated via VOIZA_KEYSTORE_PROPERTIES.
// With no file, the release build still assembles — unsigned — which is what
// CI wants.
// ---------------------------------------------------------------------------
val keystoreProps: Properties? = run {
    val explicit = providers.environmentVariable("VOIZA_KEYSTORE_PROPERTIES").orNull
    val file = if (explicit != null) rootDir.resolve(explicit) else rootDir.resolve("keystore.properties")
    if (!file.isFile) return@run null
    Properties().apply { file.inputStream().use { load(it) } }
}
val keystoreFile: File? = keystoreProps?.getProperty("storeFile")
    ?.takeIf { it.isNotBlank() }
    ?.let { rootDir.resolve(it) }
val keystoreStorePassword: String = keystoreProps?.getProperty("storePassword").orEmpty()
val keystoreKeyAlias: String = keystoreProps?.getProperty("keyAlias").orEmpty()
val keystoreKeyPassword: String = keystoreProps?.getProperty("keyPassword")
    ?: keystoreStorePassword
val signingConfigured = keystoreFile != null &&
    keystoreStorePassword.isNotBlank() && keystoreKeyAlias.isNotBlank()

android {
    namespace = "com.voiza.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.voiza.app"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        // Backend API base (emulator -> host machine; override via gradle.properties or env)
        buildConfigField(
            "String",
            "VOIZA_API_BASE_URL",
            "\"${prop("VOIZA_API_BASE_URL", "http://10.0.2.2:4000")}\""
        )
        // LiveKit signaling URL (used only as fallback if the backend token omits url)
        buildConfigField(
            "String",
            "VOIZA_LIVEKIT_URL",
            "\"${prop("VOIZA_LIVEKIT_URL", "ws://10.0.2.2:7880")}\""
        )
    }

    signingConfigs {
        if (signingConfigured) {
            create("release") {
                storeFile = keystoreFile
                storePassword = keystoreStorePassword
                keyAlias = keystoreKeyAlias
                keyPassword = keystoreKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Signed only when a keystore is present; CI assembles an unsigned
            // release to prove the R8/ProGuard config, then the operator signs
            // the real artefact locally.
            if (signingConfigured) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    lint {
        // Cleartext traffic is intentional for local emulator dev (see README).
        disable += "ExpiredTargetSdkVersion"
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.03")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    // Core / lifecycle / activity
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.4")
    // ProcessLifecycleOwner: tells the notifier whether the app is foregrounded.
    implementation("androidx.lifecycle:lifecycle-process:2.8.4")
    implementation("androidx.activity:activity-compose:1.9.1")

    // Compose
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    // Navigation
    implementation("androidx.navigation:navigation-compose:2.7.7")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Serialization: Gson (Retrofit converter + JSON parsing; used consistently app-wide)
    implementation("com.google.code.gson:gson:2.11.0")

    // Networking: Retrofit + OkHttp
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

    // Image loading
    implementation("io.coil-kt:coil-compose:2.7.0")

    // Encrypted SharedPreferences for the JWT session (Keystore-backed master key)
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Lottie playback for the generated gift/effect animations (Apache-2.0)
    implementation("com.airbnb.android:lottie-compose:6.4.1")

    // LiveKit real-time audio
    implementation("io.livekit:livekit-android:2.13.0")

    // Socket.IO realtime room events
    implementation("io.socket:socket.io-client:2.1.1")

    // Tests
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
