package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.RankingBoard
import com.voiza.app.domain.model.RankingBoardKind
import com.voiza.app.domain.model.RankingPeriod
import com.voiza.app.domain.model.DiscoveryRanking
import com.voiza.app.domain.model.DiscoveryRankingKind
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.RankingsRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The landing rankings.
 *
 * Every number on the screen is the server's aggregation over the ledger: switching a board,
 * a period or the settled toggle asks again rather than re-sorting what is on screen. A claim
 * sends only the board and period — the place is recomputed server-side, and the bonus it mints
 * reaches the wallet through the same push every other mint uses, so the session is re-read
 * afterwards instead of patched here.
 */
class RankingsViewModel(
    private val rankingsRepository: RankingsRepository = ServiceLocator.rankingsRepository,
    private val authRepository: AuthRepository = ServiceLocator.authRepository,
    initialBoard: RankingBoardKind = RankingBoardKind.HOST,
    initialPeriod: RankingPeriod = RankingPeriod.DAY,
) : ViewModel() {

    data class RankingsUiState(
        val board: RankingBoardKind = RankingBoardKind.HOST,
        val period: RankingPeriod = RankingPeriod.DAY,
        val settled: Boolean = false,
        val data: RankingBoard? = null,
        val loading: Boolean = false,
        val claiming: Boolean = false,
        val rewardSheetOpen: Boolean = false,
        val error: String? = null,
        val message: String? = null,
        val discoveryKind: DiscoveryRankingKind = DiscoveryRankingKind.HOSTS,
        val discoveryRegion: String? = null,
        val discoveryData: DiscoveryRanking? = null,
        val discoveryLoading: Boolean = false,
        val discoveryError: String? = null,
    )

    private val _state = MutableStateFlow(RankingsUiState(board = initialBoard, period = initialPeriod))
    val state: StateFlow<RankingsUiState> = _state.asStateFlow()

    init {
        load()
        loadDiscovery()
    }

    fun selectBoard(board: RankingBoardKind) {
        if (_state.value.board == board) return
        _state.update { it.copy(board = board) }
        load()
    }

    fun selectPeriod(period: RankingPeriod) {
        if (_state.value.period == period) return
        _state.update { it.copy(period = period) }
        load()
    }

    /** Live board <-> the finished window. The reward state rides along on either view. */
    fun toggleSettled() {
        _state.update { it.copy(settled = !it.settled) }
        load()
    }

    fun selectDiscoveryKind(kind: DiscoveryRankingKind) {
        if (_state.value.discoveryKind == kind) return
        _state.update { it.copy(discoveryKind = kind) }
        loadDiscovery()
    }

    fun selectDiscoveryRegion(region: String?) {
        val normalized = region?.uppercase()?.takeIf { it.matches(Regex("[A-Z]{2}")) }
        if (_state.value.discoveryRegion == normalized) return
        _state.update { it.copy(discoveryRegion = normalized) }
        loadDiscovery()
    }

    /** Default to the account's declared country; users can switch back to the global board. */
    fun useAccountRegionIfUnset(region: String?) {
        if (_state.value.discoveryRegion == null && !region.isNullOrBlank()) {
            selectDiscoveryRegion(region)
        }
    }

    fun loadDiscovery() {
        viewModelScope.launch {
            val request = _state.value
            _state.update { it.copy(discoveryLoading = true, discoveryError = null) }
            when (val result = rankingsRepository.discovery(request.discoveryKind, request.discoveryRegion, 10)) {
                is ApiResult.Success -> _state.update {
                    if (it.discoveryKind == request.discoveryKind && it.discoveryRegion == request.discoveryRegion) {
                        it.copy(discoveryData = result.data, discoveryLoading = false)
                    } else it
                }
                is ApiResult.Failure -> _state.update {
                    if (it.discoveryKind == request.discoveryKind && it.discoveryRegion == request.discoveryRegion) {
                        it.copy(discoveryLoading = false, discoveryError = result.message)
                    } else it
                }
            }
        }
    }

    fun load() {
        viewModelScope.launch {
            val s = _state.value
            val firstLoad = s.data == null
            _state.update { it.copy(loading = firstLoad, error = null) }
            when (val result = rankingsRepository.board(s.board, s.period, s.settled)) {
                is ApiResult.Success -> _state.update { it.copy(data = result.data, loading = false) }
                is ApiResult.Failure -> _state.update { it.copy(loading = false, error = result.message) }
            }
        }
    }

    /** A gift sent elsewhere moves the live board; re-read when the screen returns to the front. */
    fun refresh() {
        if (_state.value.data != null) load()
        loadDiscovery()
    }

    fun openRewardSheet() = _state.update { it.copy(rewardSheetOpen = true) }

    fun closeRewardSheet() = _state.update { it.copy(rewardSheetOpen = false) }

    fun claim() {
        if (_state.value.claiming) return
        val s = _state.value
        viewModelScope.launch {
            _state.update { it.copy(claiming = true, error = null) }
            when (val result = rankingsRepository.claim(s.board, s.period)) {
                is ApiResult.Success -> {
                    val receipt = result.data
                    _state.update {
                        it.copy(
                            claiming = false,
                            message = if (receipt.alreadyClaimed) {
                                "This reward was already collected."
                            } else {
                                "Collected ${receipt.amount} bonus diamonds for place ${receipt.position}."
                            },
                        )
                    }
                    // The reward state and the wallet both moved on the server; ask for both.
                    load()
                    authRepository.refreshMe()
                }
                is ApiResult.Failure -> _state.update { it.copy(claiming = false, error = result.message) }
            }
        }
    }

    fun consumeMessage() = _state.update { it.copy(message = null) }

    fun clearError() = _state.update { it.copy(error = null) }
}