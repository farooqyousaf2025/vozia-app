package com.voiza.app.data.remote.interceptor

import com.voiza.app.data.remote.SessionManager
import okhttp3.Interceptor
import okhttp3.Response

/**
 * Attaches `Authorization: Bearer <jwt>` to every /api request when a session
 * exists. The OTP endpoints are anonymous, but sending the header there too is
 * harmless; the backend simply ignores it.
 */
class AuthInterceptor(
    private val sessionManager: SessionManager,
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val token = sessionManager.token.value
        val builder = original.newBuilder()
            .header("Accept", "application/json")
        if (!token.isNullOrBlank()) {
            builder.header("Authorization", "Bearer $token")
        }
        return chain.proceed(builder.build())
    }
}
