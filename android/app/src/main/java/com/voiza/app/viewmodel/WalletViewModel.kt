package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.Transaction
import com.voiza.app.domain.model.User
import com.voiza.app.domain.model.WalletSnapshot
import com.voiza.app.domain.model.Withdrawal
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.WalletRepository
import com.voiza.app.domain.usecase.RechargeWalletUseCase
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Wallet screen: balances, ledger, simulated recharge presets, withdrawal
 * requests.
 */
class WalletViewModel(
    private val walletRepository: WalletRepository = ServiceLocator.walletRepository,
    private val rechargeUseCase: RechargeWalletUseCase = ServiceLocator.rechargeWalletUseCase,
    private val authRepository: AuthRepository = ServiceLocator.authRepository,
) : ViewModel() {

    data class WalletUiState(
        val snapshot: WalletSnapshot? = null,
        val user: User? = null,
        val loading: Boolean = false,
        val error: String? = null,
        val busyAction: BusyAction? = null,
        val message: String? = null,
    ) {
        enum class BusyAction { RECHARGE, WITHDRAW }
    }

    private val _state = MutableStateFlow(WalletUiState())
    val state: StateFlow<WalletUiState> = _state.asStateFlow()

    init {
        load()
        viewModelScope.launch {
            authRepository.currentUser.collect { user ->
                _state.update { it.copy(user = user) }
            }
        }
    }

    fun load() {
        // Balances and the ledger are the caller's own rows, so a guest has nothing to read; the
        // screen shows a sign-in prompt instead of surfacing the server's 401 text.
        if (authRepository.currentUser.value == null) {
            _state.update { it.copy(loading = false, error = null) }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            when (val result = walletRepository.getWallet()) {
                is ApiResult.Success -> _state.update {
                    it.copy(snapshot = result.data, user = result.data.user, loading = false)
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(loading = false, error = result.message)
                }
            }
        }
    }

    fun recharge(amountDiamonds: Int) {
        viewModelScope.launch {
            _state.update { it.copy(busyAction = WalletUiState.BusyAction.RECHARGE, error = null) }
            when (val result = rechargeUseCase(amountDiamonds)) {
                is ApiResult.Success -> _state.update {
                    it.copy(
                        busyAction = null,
                        message = "+${result.data.amountDiamonds} diamonds added",
                    )
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(busyAction = null, error = result.message)
                }
            }
            // Refresh the ledger + balances after the mutation.
            load()
        }
    }

    fun withdraw(amountRCoins: Int, payoutMethod: String, details: Map<String, String>) {
        if (amountRCoins <= 0) {
            _state.update { it.copy(error = "Enter a positive R-coin amount") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(busyAction = WalletUiState.BusyAction.WITHDRAW, error = null) }
            val result = walletRepository.withdraw(amountRCoins, payoutMethod, details)
            when (result) {
                is ApiResult.Success -> _state.update {
                    it.copy(
                        busyAction = null,
                        message = "Withdrawal ${result.data.id.take(8)} submitted " +
                            "(${result.data.status}) · ${result.data.receipt()}",
                    )
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(busyAction = null, error = result.message)
                }
            }
            load()
        }
    }

    fun consumeMessage() = _state.update { it.copy(message = null) }
    fun clearError() = _state.update { it.copy(error = null) }
}

/**
 * What the host is actually paid, in the server's own numbers. The fee is decided when the request is
 * booked and sent back with it, so the receipt quotes those two figures rather than re-running the
 * dial's arithmetic on the device.
 */
internal fun Withdrawal.receipt(): String =
    if (feeRCoins > 0) {
        "$netRCoins \u25C9 paid out after a $feeRCoins fee"
    } else {
        "$netRCoins \u25C9 \u00b7 no fee on this cash-out"
    }
