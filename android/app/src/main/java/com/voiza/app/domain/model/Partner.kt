package com.voiza.app.domain.model

// ---------------------------------------------------------------------------
// Become a Partner.
//
// These are the server's forms and the server's queue rows, read out of
// `GET /api/role-applications/roles` and `…/mine`. Nothing in here decides whether an account holds
// a role: a grant is a `role_applications` row with status `APPROVED` that only an operator's
// decision can write, so the app renders what it is told and never asserts a privilege from it.
//
// `role` and `status` stay raw strings on purpose. A fifth role or a new state added in the backend
// arrives as an unknown value and must still be shown to the member, not swallowed by an enum that
// refuses to parse it. [PartnerRole] and [ApplicationStatus] exist to give the known ones good
// labels and behaviour, and both answer null for anything this build has not heard of.
// ---------------------------------------------------------------------------

/** The four roles the platform takes applications for today. */
enum class PartnerRole(val wire: String, val label: String) {
    HOST("HOST", "Host"),
    AGENCY("AGENCY", "Agency"),
    COIN_SELLER("COIN_SELLER", "Coin seller"),
    BD_MANAGER("BD_MANAGER", "BD manager"),
    ;

    companion object {
        fun fromWire(value: String?): PartnerRole? =
            entries.firstOrNull { it.wire.equals(value?.trim(), ignoreCase = true) }
    }
}

/** A queue row's state, as the backend wrote it. */
enum class ApplicationStatus(val wire: String, val label: String) {
    PENDING("PENDING", "Waiting for review"),
    INFO_REQUESTED("INFO_REQUESTED", "Waiting on you"),
    APPROVED("APPROVED", "Approved"),
    REJECTED("REJECTED", "Not approved"),
    CANCELLED("CANCELLED", "Withdrawn"),
    REVOKED("REVOKED", "Revoked"),
    ;

    companion object {
        fun fromWire(value: String?): ApplicationStatus? =
            entries.firstOrNull { it.wire.equals(value?.trim(), ignoreCase = true) }
    }
}

/**
 * The widget the server asks this answer to be given in.
 *
 * [UNSUPPORTED] is the fallback for a kind this build cannot draw. It is not treated as a text box:
 * a question the app cannot answer properly is better named on screen than filled with a guess that
 * the server then refuses.
 */
enum class ApplicationFieldInput {
    TEXT,
    TEXTAREA,
    NUMBER,
    CHECKBOX,
    COUNTRY,
    PHONE,
    EMAIL,
    AGENCY,
    UNSUPPORTED,
    ;

    companion object {
        fun fromWire(value: String?): ApplicationFieldInput =
            entries.firstOrNull { it.name.equals(value?.trim(), ignoreCase = true) } ?: UNSUPPORTED
    }
}

/** One question, exactly as the form spec described it. */
data class ApplicationField(
    val key: String,
    val label: String,
    val input: ApplicationFieldInput,
    val required: Boolean,
    /** Characters for a text answer, units for a number. Null means the server set no bound. */
    val min: Int? = null,
    val max: Int? = null,
    val hint: String? = null,
)

/** A role's whole form, plus the copy the platform chose for the picker. */
data class ApplicationForm(
    val role: String,
    val title: String,
    val blurb: String,
    val benefits: List<String> = emptyList(),
    val fields: List<ApplicationField> = emptyList(),
) {
    val knownRole: PartnerRole? get() = PartnerRole.fromWire(role)

    /** The questions this build does not know how to draw — the screen says so instead of guessing. */
    val unsupportedFields: List<ApplicationField> get() = fields.filter { it.input == ApplicationFieldInput.UNSUPPORTED }
}

/** The active agency or partner account an approval opened, or the one it used. */
data class ApplicationGrant(
    val kind: String? = null,
    val id: String? = null,
    val label: String? = null,
    val status: String? = null,
)

/** One application, as the server stored it. */
data class RoleApplication(
    val id: String,
    val role: String,
    val status: String,
    val answers: Map<String, Any?> = emptyMap(),
    val submittedAt: String? = null,
    val updatedAt: String? = null,
    val decisionNote: String? = null,
    val infoRequestNote: String? = null,
    val revokedAt: String? = null,
    val revokeReason: String? = null,
    val grant: ApplicationGrant? = null,
) {
    val statusEnum: ApplicationStatus? get() = ApplicationStatus.fromWire(status)

    /** Still in front of an operator, or waiting on the applicant to answer. */
    val isOpen: Boolean get() = statusEnum == ApplicationStatus.PENDING || statusEnum == ApplicationStatus.INFO_REQUESTED

    /** The row an operator or the applicant can still act on. */
    val needsApplicant: Boolean get() = statusEnum == ApplicationStatus.INFO_REQUESTED

    val roleLabel: String get() = PartnerRole.fromWire(role)?.label ?: prettify(role)

    /** What the member was told, whichever field the decision wrote it into. */
    val noteForApplicant: String?
        get() = when (statusEnum) {
            ApplicationStatus.REJECTED -> decisionNote
            ApplicationStatus.REVOKED -> revokeReason
            ApplicationStatus.INFO_REQUESTED -> infoRequestNote
            else -> decisionNote ?: infoRequestNote
        }
}

/** GET /api/role-applications/roles, one entry per role. */
data class PartnerRoleEntry(
    val form: ApplicationForm,
    val granted: Boolean,
    val openApplication: RoleApplication?,
)

/** The picker's whole payload: the four forms, and the agencies a Host may name. */
data class PartnerCatalogue(
    val entries: List<PartnerRoleEntry> = emptyList(),
    val agencies: List<AgencyOption> = emptyList(),
)

data class AgencyOption(
    val id: String,
    val name: String,
)

/** GET /api/role-applications/mine. */
data class MyApplications(
    val applications: List<RoleApplication> = emptyList(),
    /** The roles with an `APPROVED` row. Displayed as what the account is, never used to unlock a screen. */
    val activeRoles: List<String> = emptyList(),
) {
    fun activeRoleLabels(): List<String> = activeRoles.map { PartnerRole.fromWire(it)?.label ?: prettify(it) }
}

/** `COIN_SELLER` reads as "Coin seller" wherever the app has no better label for it. */
internal fun prettify(value: String?): String =
    value?.lowercase()?.replace('_', ' ')?.replaceFirstChar { it.uppercaseChar() }.orEmpty()

/**
 * How a stored answer reads back to the member.
 *
 * Gson decodes an untyped JSON number as a `Double`, so a team size of 12 arrives as 12.0 and would
 * otherwise be shown — and offered back for the reply to an information request — as something the
 * member never typed. A checkbox reads as Yes/No because the word, not the tick, is what an answer
 * history has to carry.
 */
fun formatPartnerAnswer(value: Any?): String = when (value) {
    null -> ""
    is Boolean -> if (value) "Yes" else "No"
    is Number -> if (value.toDouble() % 1.0 == 0.0) value.toLong().toString() else value.toString()
    else -> value.toString()
}
