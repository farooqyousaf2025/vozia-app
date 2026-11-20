package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.MarketplaceOrder
import com.voiza.app.domain.model.MarketplaceSeller
import com.voiza.app.domain.repository.MarketplaceRepository
import com.voiza.app.domain.repository.WalletRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The member's coin-seller market. The catalogue and the order list are the server's projections;
 * an order stops at AWAITING_PAYMENT and a receipt is evidence for finance, so this ViewModel never
 * credits diamonds and never guesses a status or a price.
 */
class MarketplaceViewModel(
    private val marketplaceRepository: MarketplaceRepository = ServiceLocator.marketplaceRepository,
    private val walletRepository: WalletRepository = ServiceLocator.walletRepository,
) : ViewModel() {

    data class MarketplaceUiState(
        val sellers: List<MarketplaceSeller> = emptyList(),
        val orders: List<MarketplaceOrder> = emptyList(),
        val loading: Boolean = false,
        val busy: Boolean = false,
        val error: String? = null,
        val message: String? = null,
    )

    private val _state = MutableStateFlow(MarketplaceUiState())
    val state: StateFlow<MarketplaceUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            var error: String? = null
            when (val result = marketplaceRepository.sellers()) {
                is ApiResult.Success -> _state.update { it.copy(sellers = result.data) }
                is ApiResult.Failure -> error = result.message
            }
            when (val result = marketplaceRepository.orders()) {
                is ApiResult.Success -> _state.update { it.copy(orders = result.data) }
                is ApiResult.Failure -> error = error ?: result.message
            }
            _state.update { it.copy(loading = false, error = error) }
        }
    }

    /** Body carries only keys: the server prices the package and binds the buyer from the token. */
    fun createOrder(sellerId: String, packageKey: String, paymentMethod: String, note: String?) {
        if (_state.value.busy) return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            when (val result = marketplaceRepository.createOrder(sellerId, packageKey, paymentMethod, note)) {
                is ApiResult.Success -> _state.update {
                    it.copy(busy = false, message = "Order ${result.data.reference} opened · ${result.data.status}")
                }
                is ApiResult.Failure -> _state.update { it.copy(busy = false, error = result.message) }
            }
            refreshOrders()
        }
    }

    fun uploadReceipt(orderId: String, fileName: String, data: String) {
        if (_state.value.busy) return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            when (val result = marketplaceRepository.uploadReceipt(orderId, fileName, data)) {
                is ApiResult.Success -> _state.update {
                    it.copy(
                        busy = false,
                        message = if (result.data.duplicate) "That proof was already attached"
                        else "Proof uploaded · ${result.data.receiptId.take(8)}",
                    )
                }
                is ApiResult.Failure -> _state.update { it.copy(busy = false, error = result.message) }
            }
            refreshOrders()
        }
    }

    /** R-coin sale to an approved seller, reusing the wallet's booked withdrawal path. */
    fun sellRCoins(sellerId: String, amountRCoins: Int) {
        if (_state.value.busy) return
        if (amountRCoins <= 0) {
            _state.update { it.copy(error = "Enter a positive R-coin amount") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            val result = walletRepository.withdraw(
                amountRCoins,
                "SELLER",
                mapOf("sellerId" to sellerId),
            )
            when (result) {
                is ApiResult.Success -> _state.update {
                    it.copy(busy = false, message = "Sale ${result.data.id.take(8)} sent · ${result.data.status}")
                }
                is ApiResult.Failure -> _state.update { it.copy(busy = false, error = result.message) }
            }
        }
    }

    private suspend fun refreshOrders() {
        when (val result = marketplaceRepository.orders()) {
            is ApiResult.Success -> _state.update { it.copy(orders = result.data) }
            is ApiResult.Failure -> Unit // the action's own result is the useful error here
        }
    }

    fun consumeMessage() = _state.update { it.copy(message = null) }
    fun clearError() = _state.update { it.copy(error = null) }
}
