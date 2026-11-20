package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.apiCall
import com.voiza.app.data.remote.dto.AgencyAnnouncementBody
import com.voiza.app.di.ServiceLocator
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AgencyAnnouncementItem(
    val id: String,
    val title: String,
    val body: String,
    val createdAt: String,
    val recipientCount: Int = 0,
    val readCount: Int = 0,
    val agencyName: String = "",
    val isRead: Boolean = false,
)

class AgencyAnnouncementsViewModel : ViewModel() {
    data class State(
        val items: List<AgencyAnnouncementItem> = emptyList(),
        val title: String = "",
        val body: String = "",
        val loading: Boolean = false,
        val sending: Boolean = false,
        val error: String? = null,
        val notice: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state = _state.asStateFlow()

    fun setTitle(value: String) = _state.update { it.copy(title = value.take(100), error = null, notice = null) }
    fun setBody(value: String) = _state.update { it.copy(body = value.take(3000), error = null, notice = null) }

    fun loadOwner(silent: Boolean = false) = viewModelScope.launch {
        _state.update { it.copy(loading = if (silent) it.loading else it.items.isEmpty(), error = if (silent) it.error else null) }
        when (val result = apiCall { ServiceLocator.apiService.agencyAnnouncements() }) {
            is ApiResult.Success -> _state.update { s -> s.copy(
                loading = false,
                items = result.data.announcements.orEmpty().mapNotNull { row ->
                    val id = row.id?.takeIf(String::isNotBlank) ?: return@mapNotNull null
                    AgencyAnnouncementItem(id, row.title.orEmpty(), row.body.orEmpty(), row.createdAt.orEmpty(),
                        row.recipientCount ?: 0, row.readCount ?: 0)
                },
            ) }
            is ApiResult.Failure -> _state.update { it.copy(loading = false, error = result.message) }
        }
    }

    fun publish() = viewModelScope.launch {
        val title = _state.value.title.trim()
        val body = _state.value.body.trim()
        if (title.isEmpty() || body.isEmpty()) {
            _state.update { it.copy(error = "Enter both a title and a message.") }
            return@launch
        }
        _state.update { it.copy(sending = true, error = null, notice = null) }
        when (val result = apiCall { ServiceLocator.apiService.publishAgencyAnnouncement(AgencyAnnouncementBody(title, body)) }) {
            is ApiResult.Success -> _state.update { it.copy(
                sending = false, title = "", body = "",
                notice = "Announcement published to ${result.data.announcement?.recipientCount ?: 0} active hosts.",
            ) }.also { loadOwner() }
            is ApiResult.Failure -> _state.update { it.copy(sending = false, error = result.message) }
        }
    }

    fun loadHostInbox(silent: Boolean = false) = viewModelScope.launch {
        _state.update { it.copy(loading = if (silent) it.loading else it.items.isEmpty(), error = if (silent) it.error else null) }
        when (val result = apiCall { ServiceLocator.apiService.myAgencyAnnouncements() }) {
            is ApiResult.Success -> _state.update { s -> s.copy(
                loading = false,
                items = result.data.announcements.orEmpty().mapNotNull { row ->
                    val id = row.id?.takeIf(String::isNotBlank) ?: return@mapNotNull null
                    AgencyAnnouncementItem(id, row.title.orEmpty(), row.body.orEmpty(), row.createdAt.orEmpty(),
                        agencyName = row.agencyName.orEmpty(), isRead = row.isRead ?: false)
                },
            ) }
            is ApiResult.Failure -> _state.update { it.copy(loading = false, error = result.message) }
        }
    }

    fun markRead(id: String) = viewModelScope.launch {
        when (val result = apiCall { ServiceLocator.apiService.markAgencyAnnouncementRead(id) }) {
            is ApiResult.Success -> _state.update { s -> s.copy(items = s.items.map { if (it.id == id) it.copy(isRead = true) else it }) }
            is ApiResult.Failure -> _state.update { it.copy(error = result.message) }
        }
    }
}
