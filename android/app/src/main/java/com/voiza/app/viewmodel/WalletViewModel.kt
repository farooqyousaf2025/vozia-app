package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.CheckoutSession
import com.voiza.app.domain.model.DiamondPackage
import com.voiza.app.domain.model.FirstRechargeStatus
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
 * Wallet screen: balances, ledger, server-driven top-up packages, the first-recharge
 * banner and withdrawal requests.
 *
 * Pack chips go through Stripe when a publishable key was supplied at build time; stacks without a
 * Stripe account keep the simulated recharge path. Either way the balance is re-read from the
 * ledger — a PaymentIntent, or a successful sheet, never credits diamonds on the device. The signed
 * webhook is the only thing that can move them.
 */
class WalletViewModel(
    private val walletRepository: WalletRepository = ServiceLocator.walletRepository,
    private val rechargeUseCase: RechargeWalletUseCase = ServiceLocator.rechargeWalletUseCase,
    private val authRepository: AuthRepository = ServiceLocator.authRepository,
    private val cardPaymentsEnabled: Boolean = ServiceLocator.stripeConfigured,
) : ViewModel() {

    /** One-shot hand-off to PaymentSheet. Cleared as soon as the sheet is launched. */
    data class CheckoutPresentation(
        val clientSecret: String,
        val amountCents: Int,
        val currency: String,
        val packageId: String?,
    )

    /** Domain-level view of the sheet result; the ViewModel never imports Stripe classes. */
    enum class PaymentResult { COMPLETED, CANCELED, FAILED }

    data class WalletUiState(
        val snapshot: WalletSnapshot? = null,
        val user: User? = null,
        /** Operator-set packs in the server's order. Empty on a backend with no catalogue yet. */
        val packages: List<DiamondPackage> = emptyList(),
        val firstRecharge: FirstRechargeStatus? = null,
        /** The last intent we created, kept for diagnostics. Never credits the balance locally. */
        val checkoutSession: CheckoutSession? = null,
        /** Set when a freshly created intent is waiting to be presented, then cleared. */
        val pendingPayment: CheckoutPresentation? = null,
        val loading: Boolean = false,
        val error: String? = null,
        val busyAction: BusyAction? = null,
        val message: String? = null,
    ) {
        enum class BusyAction { RECHARGE, WITHDRAW, CHECKOUT }
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
            var error: String? = null

            when (val result = walletRepository.getWallet()) {
                is ApiResult.Success -> _state.update {
                    it.copy(
                        snapshot = result.data,
                        user = result.data.user,
                        // The wallet envelope also carries the gate; keep it when the dedicated
                        // route is unavailable on an older backend.
                        firstRecharge = result.data.firstRecharge ?: it.firstRecharge,
                    )
                }
                is ApiResult.Failure -> error = result.message
            }
            when (val result = walletRepository.packages()) {
                is ApiResult.Success -> _state.update { it.copy(packages = result.data) }
                is ApiResult.Failure -> error = error ?: result.message
            }
            when (val result = walletRepository.firstRecharge()) {
                is ApiResult.Success -> _state.update { it.copy(firstRecharge = result.data) }
                is ApiResult.Failure -> Unit // the envelope copy above is enough to explain the gate
            }

            // Spinner and error are published last so a section that answered never flashes alone.
            _state.update { it.copy(loading = false, error = error) }
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

    /**
     * The single decision behind a top-up chip. A server pack on a Stripe-configured build goes
     * through checkout; presets on older backends (or a build with no key) keep the simulated path.
     */
    fun topUp(packageId: String?, amountDiamonds: Int) {
        if (cardPaymentsEnabled && !packageId.isNullOrBlank()) {
            checkout(packageId)
        } else {
            recharge(amountDiamonds)
        }
    }

    /**
     * Create a PaymentIntent for one of the server's packs. The intent is handed to the screen as a
     * one-shot event; it never credits diamonds — only the signed webhook does that.
     */
    fun checkout(packageId: String) {
        if (_state.value.busyAction != null) return
        viewModelScope.launch {
            _state.update { it.copy(busyAction = WalletUiState.BusyAction.CHECKOUT, error = null) }
            when (val result = walletRepository.checkout(packageId = packageId)) {
                is ApiResult.Success -> _state.update {
                    it.copy(
                        busyAction = null,
                        checkoutSession = result.data,
                        pendingPayment = CheckoutPresentation(
                            clientSecret = result.data.clientSecret,
                            amountCents = result.data.amountCents,
                            currency = result.data.currency,
                            packageId = result.data.packageId,
                        ),
                    )
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(busyAction = null, error = result.message)
                }
            }
        }
    }

    /** Called once the sheet has been launched so a recomposition cannot reuse the client secret. */
    fun paymentPresented() = _state.update { it.copy(pendingPayment = null) }

    /**
     * PaymentSheet's result, translated by the screen into a plain enum. A completed sheet means
     * the card was accepted, not that diamonds were credited: re-read the ledger and let the
     * server's webhook do the settlement.
     */
    fun onPaymentResult(result: PaymentResult, error: String? = null) {
        _state.update { it.copy(busyAction = null, pendingPayment = null) }
        when (result) {
            PaymentResult.COMPLETED -> {
                _state.update {
                    it.copy(message = "Payment accepted \u2014 diamonds arrive when Stripe confirms it")
                }
                load()
            }
            PaymentResult.CANCELED -> _state.update { it.copy(message = "Card payment canceled") }
            PaymentResult.FAILED -> _state.update {
                it.copy(error = error?.takeIf { text -> text.isNotBlank() } ?: "Card payment failed")
            }
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
