package com.voiza.app.domain.usecase

import com.voiza.app.data.remote.ApiResult
import com.voiza.app.domain.model.Gift
import com.voiza.app.domain.model.GiftCatalogue
import com.voiza.app.domain.model.Leaderboard
import com.voiza.app.domain.model.RankBoard
import com.voiza.app.domain.model.SendGiftOutcome
import com.voiza.app.domain.model.Transaction
import com.voiza.app.domain.repository.GiftRepository
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a non-replayed, non-combo send answers: the shape every test below starts from. */
private fun sendOutcome(transaction: Transaction, replayed: Boolean = false, comboCount: Int = 1) =
    SendGiftOutcome(transaction, replayed, if (comboCount > 1) "c1" else null, comboCount)

/**
 * The client-side purchase guard is only a UX check — the ledger is authoritative
 * — but it is the check that decides whether a tap costs the user a round trip,
 * so its arithmetic is worth pinning.
 */
class SendGiftUseCaseTest {

    private class FakeGiftRepository : GiftRepository {
        var call: Quad? = null
        var outcome: ApiResult<SendGiftOutcome> = ApiResult.Success(sendOutcome(transaction))

        data class Quad(
            val roomId: String,
            val receiverId: String,
            val giftId: String,
            val quantity: Int,
            val idempotencyKey: String?,
        )

        override suspend fun getGifts(): ApiResult<GiftCatalogue> =
            ApiResult.Failure("not used")

        override suspend fun sendGift(
            roomId: String,
            receiverId: String,
            giftId: String,
            quantity: Int,
            idempotencyKey: String?,
        ): ApiResult<SendGiftOutcome> {
            call = Quad(roomId, receiverId, giftId, quantity, idempotencyKey)
            return outcome
        }

        override suspend fun getLeaderboard(
            window: String,
            board: RankBoard,
        ): ApiResult<Leaderboard> = ApiResult.Failure("not used")

        companion object {
            val transaction = Transaction(
                id = "tx1",
                type = "GIFT_SENT",
                amountDiamonds = -20,
                amountRCoins = 18,
                giftName = "Rose",
                sender = null,
                receiver = null,
                createdAt = "2026-10-22T00:00:00.000Z",
            )
        }
    }

    private val rose = Gift(
        id = "g1",
        name = "Rose",
        iconUrl = "/gifts/rose.png",
        animationUrl = null,
        soundUrl = "/gifts/sounds/chime.wav",
        diamondPrice = 10,
        rCoinValue = 9,
        category = "ROSE",
        minVipLevel = 0,
    )

    @Test
    fun `a quantity of zero never reaches the network`() = runTest {
        val repo = FakeGiftRepository()
        val result = SendGiftUseCase(repo)("r1", "u2", rose, 0, senderDiamondBalance = 100)

        assertTrue(result is ApiResult.Failure)
        assertEquals(null, repo.call)
    }

    @Test
    fun `an unaffordable gift is refused locally with the cost in the message`() = runTest {
        val repo = FakeGiftRepository()
        val result = SendGiftUseCase(repo)("r1", "u2", rose, 12, senderDiamondBalance = 100)

        // 12 x 10 = 120 diamonds against a 100 balance.
        assertEquals(
            "Not enough diamonds (need 120, have 100)",
            (result as ApiResult.Failure).message,
        )
        assertEquals(null, repo.call)
    }

    @Test
    fun `an unknown balance is sent to the server rather than guessed`() = runTest {
        val repo = FakeGiftRepository()
        val result = SendGiftUseCase(repo)("r1", "u2", rose, 3, senderDiamondBalance = null)

        assertTrue(result is ApiResult.Success)
        assertEquals(FakeGiftRepository.Quad("r1", "u2", "g1", 3, null), repo.call)
    }

    @Test
    fun `an idempotency key reaches the server untouched`() = runTest {
        val repo = FakeGiftRepository()
        SendGiftUseCase(repo)("r1", "u2", rose, 2, 100, idempotencyKey = "k-42")

        assertEquals("k-42", repo.call?.idempotencyKey)
    }

    @Test
    fun `the server replay flag and combo tally ride along on the receipt`() = runTest {
        val repo = FakeGiftRepository().apply {
            outcome = ApiResult.Success(sendOutcome(FakeGiftRepository.transaction, replayed = true, comboCount = 4))
        }
        val receipt = (SendGiftUseCase(repo)("r1", "u2", rose, 1, 100) as ApiResult.Success).data

        assertTrue(receipt.replayed)
        assertEquals(4, receipt.comboCount)
    }

    @Test
    fun `a receipt carries the gift and quantity for the optimistic overlay`() = runTest {
        val repo = FakeGiftRepository()
        val receipt = (SendGiftUseCase(repo)("r1", "u2", rose, 2, 100) as ApiResult.Success).data

        assertEquals(rose, receipt.gift)
        assertEquals(2, receipt.quantity)
        assertEquals("tx1", receipt.transaction.id)
    }

    @Test
    fun `the server rejection is passed through with its status code`() = runTest {
        val repo = FakeGiftRepository().apply {
            outcome = ApiResult.Failure("This gift needs VIP 8", httpCode = 403)
        }
        val result = SendGiftUseCase(repo)("r1", "u2", rose, 1, 100)

        assertEquals(403, (result as ApiResult.Failure).httpCode)
    }
}
