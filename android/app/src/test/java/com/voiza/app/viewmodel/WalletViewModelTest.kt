package com.voiza.app.viewmodel

import com.voiza.app.data.remote.ApiResult
import com.voiza.app.domain.model.CheckoutSession
import com.voiza.app.domain.model.DiamondPackage
import com.voiza.app.domain.model.FirstRechargeStatus
import com.voiza.app.domain.model.Transaction
import com.voiza.app.domain.model.User
import com.voiza.app.domain.model.WalletSnapshot
import com.voiza.app.domain.model.WalletStats
import com.voiza.app.domain.model.Withdrawal
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.OtpChallenge
import com.voiza.app.domain.repository.WalletRepository
import com.voiza.app.domain.usecase.RechargeWalletUseCase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The wallet must draw the operator's packs and the gate from the server, and a PaymentIntent must
 * never be mistaken for money arriving. Hand-written fakes and an unconfined Main dispatcher keep
 * the state writes synchronous, matching the rest of the view-model tests.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class WalletViewModelTest {

    private lateinit var repository: FakeWalletRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        repository = FakeWalletRepository()
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun viewModel(cardPaymentsEnabled: Boolean = false) = WalletViewModel(
        walletRepository = repository,
        rechargeUseCase = RechargeWalletUseCase(repository),
        authRepository = FakeAuthRepository(),
        cardPaymentsEnabled = cardPaymentsEnabled,
    )

    @Test
    fun `load draws the operator's packs and the gate from the server`() {
        val vm = viewModel()

        assertEquals(1, vm.state.value.packages.size)
        assertEquals("Starter", vm.state.value.packages.first().name)
        assertNotNull(vm.state.value.firstRecharge)
        assertFalse(vm.state.value.firstRecharge!!.completed)
        assertNull(vm.state.value.error)
    }

    @Test
    fun `the gate in the wallet envelope survives a missing dedicated route`() {
        repository.firstRechargeResult = ApiResult.Failure("route not deployed")
        val vm = viewModel()

        assertNotNull("the envelope copy should explain the gate", vm.state.value.firstRecharge)
        assertTrue(vm.state.value.firstRecharge!!.required)
        // An unavailable optional route must not turn the whole screen into an error.
        assertNull(vm.state.value.error)
    }

    @Test
    fun `a checkout intent is held for a card sheet but never credits the balance`() {
        val vm = viewModel()
        val balanceBefore = vm.state.value.user?.diamondBalance

        vm.checkout("p1")

        assertNotNull(vm.state.value.checkoutSession)
        assertEquals("pi_1_secret", vm.state.value.checkoutSession!!.clientSecret)
        assertEquals("checkout must not mint diamonds locally", 0, repository.rechargeCalls)
        assertEquals(balanceBefore, vm.state.value.user?.diamondBalance)
    }

    @Test
    fun `a pack tap creates an intent instead of minting diamonds when cards are enabled`() {
        val vm = viewModel(cardPaymentsEnabled = true)
        val balanceBefore = vm.state.value.user?.diamondBalance

        vm.topUp("p1", 150)

        assertNotNull(vm.state.value.pendingPayment)
        assertEquals("pi_1_secret", vm.state.value.pendingPayment!!.clientSecret)
        assertEquals("a paid pack must not use the simulated mint", 0, repository.rechargeCalls)
        assertEquals(balanceBefore, vm.state.value.user?.diamondBalance)
    }

    @Test
    fun `a legacy preset keeps the simulated path when no publishable key is configured`() {
        val vm = viewModel(cardPaymentsEnabled = false)

        vm.topUp(null, 100)

        assertEquals(1, repository.rechargeCalls)
        assertNull(vm.state.value.pendingPayment)
    }

    @Test
    fun `a completed sheet re-reads the ledger and cannot re-present the client secret`() {
        val vm = viewModel(cardPaymentsEnabled = true)
        vm.topUp("p1", 150)
        val walletCallsBefore = repository.walletCalls

        vm.paymentPresented()
        assertNull(vm.state.value.pendingPayment)

        vm.onPaymentResult(WalletViewModel.PaymentResult.COMPLETED)

        assertTrue("the ledger must be re-read after payment", repository.walletCalls > walletCallsBefore)
        assertEquals(0, repository.rechargeCalls)
        assertNotNull(vm.state.value.message)
    }

    @Test
    fun `a failed sheet shows the reason and leaves no pending intent`() {
        val vm = viewModel(cardPaymentsEnabled = true)
        vm.topUp("p1", 150)

        vm.onPaymentResult(WalletViewModel.PaymentResult.FAILED, "Card declined")

        assertEquals("Card declined", vm.state.value.error)
        assertNull(vm.state.value.pendingPayment)
    }

    @Test
    fun `a refused checkout leaves no session and shows the server's reason`() {
        repository.checkoutResult = ApiResult.Failure("Payments are in demo mode", httpCode = 403)
        val vm = viewModel()

        vm.checkout("p1")

        assertNull(vm.state.value.checkoutSession)
        assertEquals("Payments are in demo mode", vm.state.value.error)
    }

    private class FakeWalletRepository : WalletRepository {
        var firstRechargeResult: ApiResult<FirstRechargeStatus> =
            ApiResult.Success(FirstRechargeStatus(required = true, completed = false, completedAt = null, count = 0))
        var checkoutResult: ApiResult<CheckoutSession> = ApiResult.Success(
            CheckoutSession("pi_1", "pi_1_secret", 199, "usd", 150, "p1", "pk_test_"),
        )
        var rechargeCalls = 0
        var walletCalls = 0

        override suspend fun getWallet(): ApiResult<WalletSnapshot> {
            walletCalls++
            return ApiResult.Success(wallet)
        }
        override suspend fun packages(): ApiResult<List<DiamondPackage>> = ApiResult.Success(
            listOf(DiamondPackage("p1", "starter", "Starter", 100, 50, 150, 199, "usd", 1)),
        )
        override suspend fun firstRecharge(): ApiResult<FirstRechargeStatus> = firstRechargeResult
        override suspend fun checkout(packageId: String?, amountDiamonds: Int?): ApiResult<CheckoutSession> = checkoutResult
        override suspend fun recharge(amountDiamonds: Int): ApiResult<Transaction> {
            rechargeCalls++
            return ApiResult.Failure("not used")
        }
        override suspend fun withdraw(
            amountRCoins: Int,
            payoutMethod: String,
            payoutDetails: Map<String, String>,
        ): ApiResult<Withdrawal> = ApiResult.Failure("not used")
    }

    private class FakeAuthRepository : AuthRepository {
        override val currentUser = MutableStateFlow<User?>(user)
        override suspend fun requestOtp(phone: String): ApiResult<OtpChallenge> = ApiResult.Failure("not used")
        override suspend fun verifyOtp(phone: String, code: String, username: String?): ApiResult<User> = ApiResult.Failure("not used")
        override suspend fun refreshMe(): ApiResult<User> = ApiResult.Success(user)
        override suspend fun updateProfile(username: String?, avatarUrl: String?, bio: String?): ApiResult<User> = ApiResult.Success(user)
        override fun logout() = Unit
    }

    companion object {
        private val user = User(
            id = "u1",
            phone = "+10000000000",
            username = "Me",
            avatarUrl = null,
            bio = null,
            gender = null,
            countryCode = null,
            diamondBalance = 0,
            rCoinBalance = 0,
            totalGiftsSent = 0,
            totalGiftsReceived = 0,
            userType = "USER",
            status = "ACTIVE",
            isVerified = false,
        )
        private val wallet = WalletSnapshot(
            user = user,
            transactions = emptyList(),
            stats = WalletStats(0, 0, 0),
            firstRecharge = FirstRechargeStatus(required = true, completed = false, completedAt = null, count = 0),
        )
    }
}
