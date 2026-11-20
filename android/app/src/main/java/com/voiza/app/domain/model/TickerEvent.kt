package com.voiza.app.domain.model

/** One app-wide announcement line: a top-up, top ranker, game start or game winner. */
data class TickerEvent(
    val id: String,
    val kind: String,
    val text: String,
    val username: String? = null,
    val userId: String? = null,
    val amount: Int? = null,
    val roomId: String? = null,
    val region: String? = null,
    val createdAt: String = "",
)
