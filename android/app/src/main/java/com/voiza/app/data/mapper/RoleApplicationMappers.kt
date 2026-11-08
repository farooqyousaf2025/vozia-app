package com.voiza.app.data.mapper

import com.voiza.app.data.remote.dto.AgencyOptionDto
import com.voiza.app.data.remote.dto.ApplicationFieldDto
import com.voiza.app.data.remote.dto.ApplicationFormDto
import com.voiza.app.data.remote.dto.ApplicationGrantDto
import com.voiza.app.data.remote.dto.MyApplicationsDto
import com.voiza.app.data.remote.dto.RoleApplicationDto
import com.voiza.app.data.remote.dto.RoleCatalogueDto
import com.voiza.app.domain.model.AgencyOption
import com.voiza.app.domain.model.ApplicationField
import com.voiza.app.domain.model.ApplicationFieldInput
import com.voiza.app.domain.model.ApplicationForm
import com.voiza.app.domain.model.ApplicationGrant
import com.voiza.app.domain.model.MyApplications
import com.voiza.app.domain.model.PartnerCatalogue
import com.voiza.app.domain.model.PartnerRoleEntry
import com.voiza.app.domain.model.RoleApplication

// ---------------------------------------------------------------------------
// Become a Partner.
//
// Every field is copied, and nothing is inferred: an absent list becomes empty, a null inside one is
// dropped rather than mapped, an absent answer map becomes empty, and a `required` the server did not
// send is read as false — which is safe here only because the backend re-checks every question on
// submission, so the form drawn from this mapping can be prettier than the truth but cannot make a
// submission the server accepts more easily.
// ---------------------------------------------------------------------------

fun ApplicationFieldDto.toDomain(): ApplicationField = ApplicationField(
    key = key.orEmpty(),
    label = label.orEmpty(),
    input = ApplicationFieldInput.fromWire(input),
    required = required ?: false,
    min = min,
    max = max,
    hint = hint,
)

fun ApplicationFormDto.toDomain(): ApplicationForm = ApplicationForm(
    role = role.orEmpty(),
    title = title.orEmpty(),
    blurb = blurb.orEmpty(),
    benefits = benefits.orEmpty().filterNotNull(),
    fields = fields.orEmpty().filterNotNull().map { it.toDomain() },
)

fun ApplicationGrantDto.toDomain(): ApplicationGrant = ApplicationGrant(
    kind = kind,
    id = id,
    label = label,
    status = status,
)

fun RoleApplicationDto.toDomain(): RoleApplication = RoleApplication(
    id = id.orEmpty(),
    role = role.orEmpty(),
    status = status.orEmpty(),
    answers = data.orEmpty(),
    submittedAt = submittedAt,
    updatedAt = updatedAt,
    decisionNote = decisionNote,
    infoRequestNote = infoRequestNote,
    revokedAt = revokedAt,
    revokeReason = revokeReason,
    grant = grant?.toDomain(),
)

fun AgencyOptionDto.toDomain(): AgencyOption = AgencyOption(
    id = id.orEmpty(),
    name = name.orEmpty(),
)

/**
 * The picker's payload.
 *
 * `granted` is the server's read of an `APPROVED` row, not something worked out from the account's
 * `userType` — that column is a display marker the room service has always written for anybody who
 * opened a room, so trusting it here would tell a member they are a host when nothing granted it.
 */
fun RoleCatalogueDto.toDomain(): PartnerCatalogue = PartnerCatalogue(
    entries = roles.orEmpty().filterNotNull().map { form ->
        PartnerRoleEntry(
            form = form.toDomain(),
            granted = form.granted ?: false,
            openApplication = form.openApplication?.toDomain(),
        )
    },
    agencies = agencies.orEmpty().filterNotNull().map { it.toDomain() },
)

fun MyApplicationsDto.toDomain(): MyApplications = MyApplications(
    applications = applications.orEmpty().filterNotNull().map { it.toDomain() },
    activeRoles = activeRoles.orEmpty().filterNotNull(),
)
