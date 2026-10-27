# Voiza app ProGuard/R8 rules.

# Keep Retrofit service interfaces (generic signature retention required for Gson parsing).
-keepattributes Signature
-keepattributes *Annotation*
-keepattributes InnerClasses
-keepattributes EnclosingMethod

-keep,allowobfuscation,allowshrinking interface retrofit2.Call
-keep,allowobfuscation,allowshrinking class retrofit2.Response
-keep,allowobfuscation,allowshrinking class kotlin.coroutines.Continuation

# Retrofit: keep service interfaces
-keep class com.voiza.app.data.remote.VoizaApiService { *; }

# Gson: keep DTOs and models (serialized by reflection)
-keep class com.voiza.app.data.remote.dto.** { *; }
-keep class com.voiza.app.domain.model.** { *; }
-keepclassmembers class * {
    @com.google.gson.annotations.SerializedName <fields>;
}

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# LiveKit
-keep class io.livekit.android.** { *; }
-dontwarn io.livekit.**

# Socket.IO
-keep class io.socket.** { *; }
-dontwarn io.socket.**
-dontwarn org.json.**

# Coil
-dontwarn coil.**

# Tink (backs EncryptedSharedPreferences). Its primitives are looked up by class
# name, so R8 must not rename or prune them.
-keep class com.google.crypto.tink.** { *; }
-keep class androidx.security.crypto.** { *; }
-dontwarn com.google.crypto.tink.**

# Kotlin metadata
-keep class kotlin.Metadata { *; }
-keepclassmembers class **$WhenMappings {
    <fields>;
}
