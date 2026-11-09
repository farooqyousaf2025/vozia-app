package com.voiza.app.data.remote.dto

import com.google.gson.annotations.SerializedName

// ---------------------------------------------------------------------------
// The agency's own book (`/api/agency`, migration 0040).
//
// Four GETs, each wrapped in the object the controller sends. There is no body type in this file
// because nothing a member can send changes a figure here: rates and batches are an operator's
// decisions, and the agency is named by the token rather than by a parameter, so no payload can
// point at somebody else's roster.
//
// Gson builds these without running their initialisers, so every key whose absence would change the
// answer is nullable and takes its fallback in the mapper.
// ---------------------------------------------------------------------------

/** `master` is null for a master agency — the absence is the fact, not a missing value. */
data class AgencyMasterDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("name") val name: String? = null,
    @SerializedName("overrideBps") val overrideBps: Int? = null,
    @SerializedName("overrideLabel") val overrideLabel: String? = null,
)

data class AgencyEarningsDto(
    @SerializedName("accruedCoins") val accruedCoins: Int? = null,
    @SerializedName("overrideCoins") val overrideCoins: Int? = null,
    @SerializedName("retainedCoins") val retainedCoins: Int? = null,
    @SerializedName("receivedOverrideCoins") val receivedOverrideCoins: Int? = null,
    @SerializedName("last30dCoins") val last30dCoins: Int? = null,
    @SerializedName("last30dOverrideCoins") val last30dOverrideCoins: Int? = null,
)

/** Minor units of `currency`. Absent means the account has not been opened yet — no gift has accrued. */
data class AgencyAccountDto(
    @SerializedName("currency") val currency: String? = null,
    @SerializedName("availableMinor") val availableMinor: Int? = null,
    @SerializedName("pendingMinor") val pendingMinor: Int? = null,
    @SerializedName("frozenMinor") val frozenMinor: Int? = null,
)

/** GET /api/agency/position. */
data class AgencyPositionDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("name") val name: String? = null,
    /** MASTER or SUB, derived server-side from the parent link. Kept a string so a new value parses. */
    @SerializedName("kind") val kind: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
    @SerializedName("commissionLabel") val commissionLabel: String? = null,
    @SerializedName("hostCount") val hostCount: Int? = null,
    @SerializedName("activeHostCount") val activeHostCount: Int? = null,
    @SerializedName("subAgencyCount") val subAgencyCount: Int? = null,
    @SerializedName("master") val master: AgencyMasterDto? = null,
    @SerializedName("earnings") val earnings: AgencyEarningsDto? = null,
    @SerializedName("account") val account: AgencyAccountDto? = null,
)

data class AgencyPositionEnvelope(
    @SerializedName("agency") val agency: AgencyPositionDto? = null,
)

/** GET /api/agency/hosts. */
data class AgencyHostDto(
    @SerializedName("username") val username: String? = null,
    @SerializedName("avatarUrl") val avatarUrl: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("joinedAt") val joinedAt: String? = null,
    @SerializedName("commissionLabel") val commissionLabel: String? = null,
    @SerializedName("accruedCoins") val accruedCoins: Int? = null,
    @SerializedName("last30dCoins") val last30dCoins: Int? = null,
)

data class AgencyHostsEnvelope(
    @SerializedName("hosts") val hosts: List<AgencyHostDto>? = null,
)

/** GET /api/agency/sub-agencies — master-only; a sub-agency is refused with 403 `master_only`. */
data class AgencySubDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("name") val name: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("hostCount") val hostCount: Int? = null,
    @SerializedName("activeHostCount") val activeHostCount: Int? = null,
    @SerializedName("parentOverrideBps") val parentOverrideBps: Int? = null,
    @SerializedName("parentOverrideLabel") val parentOverrideLabel: String? = null,
    @SerializedName("accruedCoins") val accruedCoins: Int? = null,
    @SerializedName("overrideCoins") val overrideCoins: Int? = null,
    @SerializedName("retainedCoins") val retainedCoins: Int? = null,
)

data class AgencySubsEnvelope(
    @SerializedName("subAgencies") val subAgencies: List<AgencySubDto>? = null,
)

/** GET /api/agency/settlements. `paidAt` is null until finance records the transfer. */
data class AgencySettlementDto(
    @SerializedName("reference") val reference: String? = null,
    @SerializedName("amount") val amount: Int? = null,
    @SerializedName("currency") val currency: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("periodFrom") val periodFrom: String? = null,
    @SerializedName("periodTo") val periodTo: String? = null,
    @SerializedName("entryCount") val entryCount: Int? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
    @SerializedName("paidAt") val paidAt: String? = null,
)

data class AgencySettlementsEnvelope(
    @SerializedName("settlements") val settlements: List<AgencySettlementDto>? = null,
)
