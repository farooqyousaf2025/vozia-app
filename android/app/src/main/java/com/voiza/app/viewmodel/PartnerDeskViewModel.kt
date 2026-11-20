package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.PartnerAccount
import com.voiza.app.domain.model.PartnerCustomer
import com.voiza.app.domain.model.PartnerDashboard
import com.voiza.app.domain.model.PartnerSellerRow
import com.voiza.app.domain.model.PartnerStatement
import com.voiza.app.domain.model.RechargeOrder
import com.voiza.app.domain.model.RechargePackage
import com.voiza.app.domain.model.SellerPayout
import com.voiza.app.domain.model.SellerReport
import com.voiza.app.domain.model.UploadedReceipt
import com.voiza.app.domain.repository.PartnerDeskRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The seller/BD desk, as the member who runs the account works it.
 *
 * `GET /api/partner/me` is the gate: it names the account, lists what it may do, and — because
 * `requireBusinessOwner` resolves the account from the token — is the call that refuses anybody who
 * does not run an active one. The sections are then read against the kind it returned: a seller never
 * calls the BD routes and a BD never calls the seller-only ones, so nobody is served a refusal the
 * screen could have avoided. The refusal stays on the server for anyone who asks directly.
 *
 * The sections fail independently and each keeps its own sentence. An order list the app cannot read
 * is not a reason to hide the cash book.
 *
 * Writes are the seller's own moves — open an order, claim payment, withdraw, attach proof — and each
 * one re-reads the affected sections afterwards, because the answer to a write is the server's new
 * state, not a figure this app adjusts locally. Crediting diamonds and paying a sale stay with
 * finance; nothing here pretends otherwise.
 */
class PartnerDeskViewModel(
    private val partnerDeskRepository: PartnerDeskRepository = ServiceLocator.partnerDeskRepository,
) : ViewModel() {

    /** The outcome of one write, shown once: a dialog closes on success, keeps the sentence on failure. */
    data class ActionEvent(val success: Boolean, val message: String)

    /** What a proof is being attached to — an order the seller opened, or a member's R-coin sale. */
    data class ReceiptTarget(val orderId: String?, val withdrawalId: String?, val label: String)

    data class PartnerDeskUiState(
        val account: PartnerAccount? = null,
        val permissions: List<String> = emptyList(),
        val paymentRails: List<String> = emptyList(),
        val dashboard: PartnerDashboard? = null,
        val packages: List<RechargePackage> = emptyList(),
        val orders: List<RechargeOrder> = emptyList(),
        val ordersTotal: Int = 0,
        val payouts: List<SellerPayout> = emptyList(),
        val statement: PartnerStatement? = null,
        val sellers: List<PartnerSellerRow> = emptyList(),
        val sellerReport: SellerReport? = null,
        val reportLoading: Boolean = false,
        val reportError: String? = null,
        val loading: Boolean = false,
        /** The whoami itself was refused — there is no desk to show, and this is the server's reason. */
        val error: String? = null,
        val dashboardError: String? = null,
        val ordersError: String? = null,
        val payoutsError: String? = null,
        val statementError: String? = null,
        val sellersError: String? = null,
        val actionBusy: Boolean = false,
        val actionEvent: ActionEvent? = null,
        val lookupBusy: Boolean = false,
        val lookup: PartnerCustomer? = null,
        val lookupError: String? = null,
    )

    private val _state = MutableStateFlow(PartnerDeskUiState())
    val state: StateFlow<PartnerDeskUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            val firstLoad = _state.value.account == null
            _state.update { it.copy(loading = firstLoad, error = null) }
            when (val result = partnerDeskRepository.whoami()) {
                is ApiResult.Failure -> _state.update { it.copy(loading = false, error = result.message) }
                is ApiResult.Success -> {
                    _state.update {
                        it.copy(
                            account = result.data.account,
                            permissions = result.data.permissions,
                            paymentRails = result.data.paymentRails,
                            loading = false,
                        )
                    }
                    loadSections(result.data.account)
                }
            }
        }
    }

    private suspend fun loadSections(account: PartnerAccount) {
        val dashboard = partnerDeskRepository.dashboard()
        val orders = partnerDeskRepository.orders()
        val statement = partnerDeskRepository.statement()
        // Kind-gated rather than called and refused: the server's answer for the wrong kind is a 403.
        val packages = if (account.isSeller) partnerDeskRepository.packages() else null
        val payouts = if (account.isSeller) partnerDeskRepository.payouts() else null
        val sellers = if (account.isBd) partnerDeskRepository.sellers() else null
        _state.update {
            it.copy(
                dashboard = (dashboard as? ApiResult.Success)?.data ?: it.dashboard,
                dashboardError = (dashboard as? ApiResult.Failure)?.message,
                orders = (orders as? ApiResult.Success)?.data?.orders ?: it.orders,
                ordersTotal = (orders as? ApiResult.Success)?.data?.total ?: it.ordersTotal,
                ordersError = (orders as? ApiResult.Failure)?.message,
                statement = (statement as? ApiResult.Success)?.data ?: it.statement,
                statementError = (statement as? ApiResult.Failure)?.message,
                packages = (packages as? ApiResult.Success)?.data ?: it.packages,
                payouts = (payouts as? ApiResult.Success)?.data?.payouts ?: it.payouts,
                payoutsError = (payouts as? ApiResult.Failure)?.message,
                sellers = (sellers as? ApiResult.Success)?.data ?: it.sellers,
                sellersError = (sellers as? ApiResult.Failure)?.message,
            )
        }
    }

    /** Re-read the sections a write touched, without flashing the whole screen back to loading. */
    private fun refreshAfterWrite() {
        val account = _state.value.account ?: return
        viewModelScope.launch { loadSections(account) }
    }

    fun acknowledgeAction() {
        _state.update { it.copy(actionEvent = null) }
    }

    fun createOrder(phone: String, packageKey: String, paymentMethod: String, note: String?) {
        runAction("Order opened.") {
            partnerDeskRepository.createOrder(phone.trim(), packageKey, paymentMethod, note?.trim()?.takeIf { s -> s.isNotEmpty() })
        }
    }

    fun markPaid(orderId: String, paymentRef: String) {
        runAction("Payment claimed. Finance reviews the proof before any diamonds are credited.") {
            partnerDeskRepository.markPaid(orderId, paymentRef.trim())
        }
    }

    fun cancelOrder(orderId: String, reason: String) {
        runAction("Order cancelled.") { partnerDeskRepository.cancelOrder(orderId, reason.trim()) }
    }

    fun attachReceipt(target: ReceiptTarget, fileName: String, base64Data: String) {
        runAction("Proof attached.") {
            partnerDeskRepository.uploadReceipt(target.orderId, target.withdrawalId, fileName, base64Data)
        }
    }

    private fun runAction(successMessage: String, call: suspend () -> ApiResult<*>) {
        if (_state.value.actionBusy) return
        viewModelScope.launch {
            _state.update { it.copy(actionBusy = true, actionEvent = null) }
            val event = when (val result = call()) {
                is ApiResult.Success -> {
                    // A duplicate upload is a success the server already holds; say so honestly.
                    val duplicate = (result.data as? UploadedReceipt)?.duplicate == true
                    ActionEvent(true, if (duplicate) "These exact bytes were already on file." else successMessage)
                }
                is ApiResult.Failure -> ActionEvent(false, result.message)
            }
            _state.update { it.copy(actionBusy = false, actionEvent = event) }
            if (event.success) refreshAfterWrite()
        }
    }

    /** The seller checks a phone before opening an order; the answer is the server's view of the member. */
    fun lookupCustomer(phone: String) {
        viewModelScope.launch {
            _state.update { it.copy(lookupBusy = true, lookup = null, lookupError = null) }
            when (val result = partnerDeskRepository.lookupCustomer(phone.trim())) {
                is ApiResult.Success -> _state.update { it.copy(lookupBusy = false, lookup = result.data) }
                is ApiResult.Failure -> _state.update { it.copy(lookupBusy = false, lookupError = result.message) }
            }
        }
    }

    fun clearLookup() {
        _state.update { it.copy(lookup = null, lookupError = null) }
    }

    /** A BD opens one seller's book. The server refuses a seller outside the territory. */
    fun openSellerReport(sellerId: String) {
        viewModelScope.launch {
            _state.update { it.copy(reportLoading = true, sellerReport = null, reportError = null) }
            when (val result = partnerDeskRepository.sellerReport(sellerId)) {
                is ApiResult.Success -> _state.update { it.copy(reportLoading = false, sellerReport = result.data) }
                is ApiResult.Failure -> _state.update { it.copy(reportLoading = false, reportError = result.message) }
            }
        }
    }

    fun closeSellerReport() {
        _state.update { it.copy(sellerReport = null, reportError = null, reportLoading = false) }
    }
}

/**
 * Whether the signed-in member runs an active seller/BD account, which is all the profile entry needs.
 *
 * `users.user_type` cannot answer this: the marker is raised on approval and never lowered, so it
 * keeps offering the desk to a suspended or revoked partner. The server's own route decides —
 * `GET /api/partner/me` re-reads `business_accounts.owner_user_id` and the ACTIVE status on every
 * request, the same lookup the desk itself is served by.
 *
 * A member is refused only by an answer that came back from the API. A call that never reached it —
 * `httpCode` null — leaves the last answer alone, so a weak signal does not take the desk away from
 * the partner who is looking for it.
 */
class PartnerAccessViewModel(
    private val partnerDeskRepository: PartnerDeskRepository = ServiceLocator.partnerDeskRepository,
) : ViewModel() {

    /** Null until the server has answered. */
    private val _runsPartnerAccount = MutableStateFlow<Boolean?>(null)
    val runsPartnerAccount: StateFlow<Boolean?> = _runsPartnerAccount.asStateFlow()

    fun check() {
        viewModelScope.launch {
            when (val result = partnerDeskRepository.whoami()) {
                is ApiResult.Success -> _runsPartnerAccount.value = true
                is ApiResult.Failure -> if (result.httpCode != null) _runsPartnerAccount.value = false
            }
        }
    }
}