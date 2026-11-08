package com.voiza.app.data.remote.dto

import com.google.gson.annotations.SerializedName

// ---------------------------------------------------------------------------
// Become a Partner (migration 0035, `/api/role-applications`).
//
// The four forms are not four screens written down in Kotlin: `GET /api/role-applications/roles`
// returns the questions themselves, so a field added in the backend appears here without a release.
// That only holds if nothing in this file assumes a fixed set of keys, so `data` stays a map and the
// role and status stay strings — an unrecognised value is displayed, not dropped.
//
// Gson builds these classes without running their initialisers, so anything whose absence would
// change the answer is nullable and gets its fallback in the mapper.
// ---------------------------------------------------------------------------

/** One question on a role form. `input` is the widget to draw; `min`/`max` mean length for text, value for a number. */
data class ApplicationFieldDto(
    @SerializedName("key") val key: String? = null,
    @SerializedName("label") val label: String? = null,
    @SerializedName("input") val input: String? = null,
    @SerializedName("required") val required: Boolean? = null,
    @SerializedName("min") val min: Int? = null,
    @SerializedName("max") val max: Int? = null,
    @SerializedName("hint") val hint: String? = null,
)

/**
 * A role's spec, and on the catalogue route also where this account stands: `granted` and
 * `openApplication` are absent from `GET /form/:role`, which answers the same shape without them.
 */
data class ApplicationFormDto(
    @SerializedName("role") val role: String? = null,
    @SerializedName("title") val title: String? = null,
    @SerializedName("blurb") val blurb: String? = null,
    @SerializedName("benefits") val benefits: List<String>? = null,
    @SerializedName("fields") val fields: List<ApplicationFieldDto>? = null,
    @SerializedName("granted") val granted: Boolean? = null,
    @SerializedName("openApplication") val openApplication: RoleApplicationDto? = null,
)

/** A row of the shortlist an AGENCY field offers — an active agency the applicant may ask to join. */
data class AgencyOptionDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("name") val name: String? = null,
)

/** GET /api/role-applications/roles. */
data class RoleCatalogueDto(
    @SerializedName("roles") val roles: List<ApplicationFormDto>? = null,
    @SerializedName("agencies") val agencies: List<AgencyOptionDto>? = null,
)

data class ApplicationGrantDto(
    @SerializedName("kind") val kind: String? = null,
    @SerializedName("id") val id: String? = null,
    @SerializedName("label") val label: String? = null,
    @SerializedName("status") val status: String? = null,
)

/**
 * One application as the server stored it.
 *
 * `data` is keyed exactly the way the form asked, and the values arrive as whatever JSON the answer
 * was — a checkbox is `true`, a team size is a number. It is kept as a map instead of being typed
 * because the only reader of it is the form that wrote it.
 */
data class RoleApplicationDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("role") val role: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("formVersion") val formVersion: Int? = null,
    @SerializedName("data") val data: Map<String, Any?>? = null,
    @SerializedName("submittedAt") val submittedAt: String? = null,
    @SerializedName("updatedAt") val updatedAt: String? = null,
    @SerializedName("reviewedAt") val reviewedAt: String? = null,
    @SerializedName("reviewedBy") val reviewedBy: String? = null,
    @SerializedName("decisionNote") val decisionNote: String? = null,
    @SerializedName("infoRequestNote") val infoRequestNote: String? = null,
    @SerializedName("revokedAt") val revokedAt: String? = null,
    @SerializedName("revokedBy") val revokedBy: String? = null,
    @SerializedName("revokeReason") val revokeReason: String? = null,
    @SerializedName("grant") val grant: ApplicationGrantDto? = null,
)

/** GET /api/role-applications/mine — this account's history, and what it holds today. */
data class MyApplicationsDto(
    @SerializedName("applications") val applications: List<RoleApplicationDto>? = null,
    @SerializedName("activeRoles") val activeRoles: List<String>? = null,
)

/** 201 from `POST /api/role-applications`, 200 from supplement and cancel. */
data class RoleApplicationEnvelope(
    @SerializedName("application") val application: RoleApplicationDto? = null,
)

/**
 * The submission. There is no account id in here: the server takes the applicant from the token, so
 * a crafted body cannot file an application for anybody else — and cannot grant anything either.
 */
data class SubmitApplicationBody(
    @SerializedName("role") val role: String,
    @SerializedName("data") val data: Map<String, Any?>,
)

/** An answer to a request for more information: only the questions being replied to. */
data class SupplementApplicationBody(
    @SerializedName("data") val data: Map<String, Any?>,
)
