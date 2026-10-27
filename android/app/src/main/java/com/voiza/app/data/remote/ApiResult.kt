package com.voiza.app.data.remote

import kotlinx.coroutines.CancellationException
import retrofit2.HttpException
import java.io.IOException

/**
 * Result envelope for all repository calls. `Failure` keeps an optional HTTP
 * status code so callers can branch on 401 (re-auth) vs 4xx business errors.
 */
sealed class ApiResult<out T> {
    data class Success<T>(val data: T) : ApiResult<T>()
    data class Failure(
        val message: String,
        val httpCode: Int? = null,
        val cause: Throwable? = null,
    ) : ApiResult<Nothing>()
}

/**
 * Wraps a suspend Retrofit call into ApiResult. Cancellation is rethrown so
 * structured concurrency is never silently broken.
 */
suspend fun <T> apiCall(block: suspend () -> T): ApiResult<T> =
    try {
        ApiResult.Success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: HttpException) {
        val bodyText = runCatching { e.response()?.errorBody()?.string() }.getOrNull()
        val message = extractErrorMessage(bodyText) ?: e.message() ?: "Request failed"
        ApiResult.Failure(message = message, httpCode = e.code(), cause = e)
    } catch (e: IOException) {
        ApiResult.Failure(message = "Network unavailable. Check your connection.", cause = e)
    } catch (e: Exception) {
        ApiResult.Failure(message = e.message ?: "Unexpected error", cause = e)
    }

/** Backend error bodies are JSON ({ error: { message, code } }, or flat { message }); fall back to raw text. */
private fun extractErrorMessage(bodyText: String?): String? {
    if (bodyText.isNullOrBlank()) return null
    val parsed = runCatching {
        val obj = org.json.JSONObject(bodyText)
        val error = obj.optJSONObject("error")
        if (error != null) {
            error.optString("message").ifBlank { error.optString("code") }
        } else {
            obj.optString("message").ifBlank { obj.optString("error") }
        }
    }.getOrNull()
    return parsed?.ifBlank { null } ?: bodyText.take(120)
}
