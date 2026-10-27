package com.voiza.app.data.remote

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.voiza.app.BuildConfig
import com.voiza.app.data.remote.interceptor.AuthInterceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

/**
 * Builders for the network stack singletons. ServiceLocator (di/) owns the
 * resulting instances; keeping these as pure functions avoids circular lazy
 * init between the interceptor and the session store. Manual DI by design —
 * no Hilt/Koin, simpler build, no annotation processor surprises.
 */
object NetworkModule {

    // Gson 2.11 deprecated setLenient() because parsing is lenient by default now.
    val gson: Gson = GsonBuilder()
        .create()

    fun buildOkHttp(sessionManager: SessionManager): OkHttpClient =
        OkHttpClient.Builder()
            .addInterceptor(AuthInterceptor(sessionManager))
            .addInterceptor(buildLogging())
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()

    fun buildRetrofit(okHttpClient: OkHttpClient): Retrofit {
        val base = BuildConfig.VOIZA_API_BASE_URL
        return Retrofit.Builder()
            .baseUrl(if (base.endsWith("/")) base else "$base/")
            .client(okHttpClient)
            .addConverterFactory(GsonConverterFactory.create(gson))
            .build()
    }

    /** Socket.IO server lives on the same host as the REST API. */
    fun socketBaseUrl(): String = BuildConfig.VOIZA_API_BASE_URL

    private fun buildLogging(): HttpLoggingInterceptor =
        HttpLoggingInterceptor().apply {
            // BODY only in debug; release must never log JWTs or chat content.
            level = if (BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.BODY
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
        }
}
