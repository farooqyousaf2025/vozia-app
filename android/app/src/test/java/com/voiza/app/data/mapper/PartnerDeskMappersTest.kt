package com.voiza.app.data.mapper

import com.google.gson.Gson
import com.voiza.app.data.remote.dto.CustomerLookupEnvelope
import com.voiza.app.data.remote.dto.PartnerDashboardEnvelope
import com.voiza.app.data.remote.dto.PartnerSellersEnvelope
import com.voiza.app.data.remote.dto.PartnerStatementEnvelope
import com.voiza.app.data.remote.dto.PartnerWhoamiEnvelope
import com.voiza.app.data.remote.dto.ReceiptUploadEnvelope
import com.voiza.app.data.remote.dto.RechargeOrderEnvelope
import com.voiza.app.data.remote.dto.RechargeOrdersEnvelope
import com.voiza.app.data.remote.dto.RechargePackagesEnvelope
import com.voiza.app.data.remote.dto.SellerPayoutsEnvelope
import com.voiza.app.data.remote.dto.SellerReportEnvelope
import com.voiza.app.domain.model.CommissionEntryStatus
import com.voiza.app.domain.model.CommissionSettlementStatus
import com.voiza.app.domain.model.PartnerAccountStatus
import com.voiza.app.domain.model.PartnerKind
import com.voiza.app.domain.model.RechargeOrderStatus
import com.voiza.app.domain.model.SellerPayoutStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the partner desk is allowed to mean on a device.
 *
 * The same two properties the agency book holds: the mapper copies the server's arithmetic and never
 * recomputes it — a price, a commission line and a cash total are the journal's figures — and a word
 * this build has not met still arrives as that word rather than as a blank or a crash. Parsed with
 * Gson exactly as Retrofit parses it, so a key the backend leaves out arrives as null instead of as
 * the declared default.
 */
class PartnerDeskMappersTest {

    private val gson = Gson()

    private val sellerJson = """
        {"account":{
          "id":"biz-seller","kind":"COIN_SELLER","code":"SLR-0001","displayName":"Corner Shop",
          "status":"ACTIVE","marketCountry":"PK","parentCode":"BD-0001","parentName":"North BD",
          "maxOrderDiamonds":100000,"dailyDiamondLimit":500000,"dailyOrderLimit":40,
          "createdAt":"2026-02-01T00:00:00.000Z"
         },
         "permissions":["recharge:create","recharge:read","customer:lookup","statement:read","payout:manage"],
         "paymentRails":["CASH","BANK","EASYPAISA","JAZZCASH"]}
    """.trimIndent()

    @Test
    fun `whoami names the account, its moves and the rails the server accepts`() {
        val parsed = gson.fromJson(sellerJson, PartnerWhoamiEnvelope::class.java).toWhoami()!!

        assertEquals(PartnerKind.COIN_SELLER, parsed.account.kind)
        assertTrue(parsed.account.isSeller)
        assertFalse(parsed.account.isBd)
        assertEquals("Coin seller", parsed.account.kindLabel)
        assertEquals("Active", parsed.account.statusLabel)
        assertEquals("North BD", parsed.account.parentName)
        assertEquals(100000, parsed.account.maxOrderDiamonds)
        assertEquals(listOf("CASH", "BANK", "EASYPAISA", "JAZZCASH"), parsed.paymentRails)
        assertTrue("recharge:create" in parsed.permissions)
    }

    @Test
    fun `a kind or status this build has not met still names itself`() {
        val parsed = gson.fromJson(
            """{"account":{"kind":"FRANCHISE","status":"ARCHIVED"},"permissions":null,"paymentRails":null}""",
            PartnerWhoamiEnvelope::class.java,
        ).toWhoami()!!

        assertNull(parsed.account.kind)
        assertEquals("FRANCHISE", parsed.account.kindLabel)
        assertNull(parsed.account.status)
        assertEquals("ARCHIVED", parsed.account.statusLabel)
        assertTrue(parsed.permissions.isEmpty())
        assertTrue(parsed.paymentRails.isEmpty())
        assertFalse(parsed.account.isSeller)
        assertFalse(parsed.account.isBd)
    }

    @Test
    fun `an envelope with no account is no whoami, not an empty one`() {
        assertNull(gson.fromJson("{}", PartnerWhoamiEnvelope::class.java).toWhoami())
        assertNull(gson.fromJson("""{"account":null}""", PartnerWhoamiEnvelope::class.java).toWhoami())
    }

    @Test
    fun `the dashboard copies the booked figures and keeps a seller's territory empty`() {
        val parsed = gson.fromJson(
            """{"account":{"kind":"COIN_SELLER","code":"SLR-0001","status":"ACTIVE"},
                "recharge":{"orders":12,"credited":9,"awaitingVerification":2,"failed":1,"reversed":0,
                            "processedDiamonds":90000,"collectedCents":150000,"netCollectedCents":147000},
                "commission":{"accruedCents":4500,"settledCents":1200,"reversedCents":0,"entryCount":9,"currency":"pkr"},
                "availableCommissionCents":4500,"sellers":[]}""",
            PartnerDashboardEnvelope::class.java,
        ).toDashboard()!!

        assertEquals(12, parsed.recharge.orders)
        assertEquals(9, parsed.recharge.credited)
        assertEquals(147000, parsed.recharge.netCollectedMinor)
        assertEquals(4500, parsed.commission.accruedMinor)
        assertEquals("pkr", parsed.commission.currency)
        assertTrue(parsed.sellers.isEmpty())

        // Keys the backend left out are null, not the Kotlin defaults, so every absent figure is zero.
        val bare = gson.fromJson(
            """{"account":{"kind":"BD_MANAGER"}}""",
            PartnerDashboardEnvelope::class.java,
        ).toDashboard()!!
        assertTrue(bare.account.isBd)
        assertEquals(0, bare.recharge.orders)
        assertEquals(0, bare.commission.accruedMinor)
        assertEquals("", bare.commission.currency)
    }

    @Test
    fun `the price list keeps only what the operator still sells`() {
        val packages = gson.fromJson(
            """{"packages":[
                 {"key":"starter","label":"Starter","diamonds":1000,"amountCents":1000,"currency":"pkr","isActive":true},
                 {"key":"retired","label":"Old","diamonds":500,"amountCents":400,"currency":"pkr","isActive":false},
                 {"key":"bulk","diamonds":100000,"amountCents":90000,"currency":"pkr"},
                 null
               ]}""",
            RechargePackagesEnvelope::class.java,
        ).toPackages()

        assertEquals(listOf("starter", "bulk"), packages.map { it.key })
        assertEquals(1000, packages[0].amountMinor)
        assertEquals(100000, packages[1].diamonds)
        assertEquals("", packages[1].label)
    }

    @Test
    fun `an order knows the two states where the seller still has a move`() {
        val envelope = gson.fromJson(
            """{"orders":[
                 {"id":"o1","reference":"RCH-0001","status":"AWAITING_PAYMENT","username":"ali",
                  "diamonds":1000,"amountCents":1000,"feeCents":20,"currency":"pkr","paymentMethod":"EASYPAISA",
                  "createdAt":"2026-11-01T00:00:00.000Z"},
                 {"id":"o2","reference":"RCH-0002","status":"AWAITING_VERIFICATION","paymentRef":"TX-99"},
                 {"id":"o3","reference":"RCH-0003","status":"CREDITED","verifiedAt":"2026-11-02T00:00:00.000Z"},
                 {"id":"o4","reference":"RCH-0004","status":"HELD_BY_RISK"}
               ],"total":4}""",
            RechargeOrdersEnvelope::class.java,
        ).toOrderPage()

        assertEquals(4, envelope.total)
        val (open, claimed, credited, unknown) = envelope.orders
        assertTrue(open.isOpen)
        assertTrue(claimed.isOpen)
        assertFalse(credited.isOpen)
        assertFalse(unknown.isOpen)
        assertEquals(RechargeOrderStatus.AWAITING_PAYMENT, open.status)
        assertEquals("Waiting for payment", open.statusLabel)
        assertEquals("TX-99", claimed.paymentRef)
        assertNull(unknown.status)
        assertEquals("HELD_BY_RISK", unknown.statusLabel)
        assertEquals(20, open.feeMinor)
        assertEquals(0, claimed.diamonds)
    }

    @Test
    fun `a write's answer is the server's new order, copied whole`() {
        val order = gson.fromJson(
            """{"order":{"id":"o1","reference":"RCH-0001","status":"AWAITING_VERIFICATION",
                "username":"ali","diamonds":1000,"amountCents":1000,"currency":"pkr",
                "paymentMethod":"CASH","paymentRef":"TX-99"}}""",
            RechargeOrderEnvelope::class.java,
        ).toOrder()!!

        assertEquals(RechargeOrderStatus.AWAITING_VERIFICATION, order.status)
        assertEquals("TX-99", order.paymentRef)
        assertNull(gson.fromJson("{}", RechargeOrderEnvelope::class.java).toOrder())
    }

    @Test
    fun `a customer lookup carries the server's view, recent orders included`() {
        val customer = gson.fromJson(
            """{"customer":{"id":"u1","username":"ali","status":"ACTIVE","created":"2026-01-01T00:00:00.000Z",
                "orders":[{"reference":"RCH-0001","status":"CREDITED","diamonds":1000}]}}""",
            CustomerLookupEnvelope::class.java,
        ).toCustomer()!!

        assertEquals("ali", customer.username)
        assertEquals("ACTIVE", customer.status)
        assertEquals(1, customer.recentOrders.size)
        assertEquals(RechargeOrderStatus.CREDITED, customer.recentOrders[0].status)
        assertNull(gson.fromJson("{}", CustomerLookupEnvelope::class.java).toCustomer())
    }

    @Test
    fun `a BD's statement has no cash book, and a seller's keeps the two halves apart`() {
        val bd = gson.fromJson(
            """{"summary":{"accruedCents":900,"settledCents":0,"reversedCents":0,"entryCount":3,"currency":"pkr"},
                "entries":[],"total":0,"settlements":[]}""",
            PartnerStatementEnvelope::class.java,
        ).toStatement()
        assertNull("a BD holds no cash", bd.cash)

        val seller = gson.fromJson(
            """{"summary":{"accruedCents":4500,"settledCents":1200,"reversedCents":100,"entryCount":9,"currency":"pkr"},
                "entries":[
                  {"id":"e1","orderReference":"RCH-0001","kind":"SELLER_PERCENT","status":"ACCRUED",
                   "basisCents":100000,"amountCents":5000,"currency":"pkr","createdAt":"2026-11-01T00:00:00.000Z"},
                  {"id":"e2","orderReference":"RCH-0002","kind":"SELLER_FIXED","status":"SETTLED",
                   "amountCents":200,"currency":"pkr","settlementReference":"SET-0001","settledAt":"2026-11-05T00:00:00.000Z"},
                  {"id":"e3","orderReference":"RCH-0003","kind":"BD_SHARE","status":"CLAWED_BACK",
                   "amountCents":300,"currency":"pkr","reversalReason":"chargeback"}
                ],"total":3,
                "settlements":[
                  {"reference":"SET-0001","amountCents":1200,"currency":"pkr","entryCount":4,"status":"PAID",
                   "periodFrom":"2026-10-01T00:00:00.000Z","periodTo":"2026-10-31T00:00:00.000Z",
                   "paidAt":"2026-11-05T00:00:00.000Z"}
                ],
                "cash":{"currency":"pkr","collectedNetCents":147000,"refundedCents":1000,
                        "commissionSettledCents":1200,"commissionAccruedCents":4500,
                        "remittanceCents":145800,"afterAccruedCents":141300,"creditedOrders":9,
                        "cashOutNetRCoins":5000,"cashOutFeeRCoins":250,"cashOutCount":2,"awaitingCashOutRCoins":800,
                        "cashOut":[{"reference":"WDR-0001","username":"sara","netRCoins":3000,"feeRCoins":150,
                                    "paidAt":"2026-11-03T00:00:00.000Z","receiptCount":1}]}}""",
            PartnerStatementEnvelope::class.java,
        ).toStatement()

        val cash = seller.cash!!
        // The money half and the R-coin half are copied as the server booked them, never summed.
        assertEquals(145800, cash.remittanceMinor)
        assertEquals(141300, cash.afterAccruedMinor)
        assertEquals(5000, cash.cashOutNetRCoins)
        assertEquals(800, cash.awaitingCashOutRCoins)
        assertEquals("sara", cash.cashOut.single().username)
        assertEquals(1, cash.cashOut.single().receiptCount)

        assertEquals(CommissionEntryStatus.ACCRUED, seller.entries[0].status)
        assertEquals(5000, seller.entries[0].amountMinor)
        assertEquals("SET-0001", seller.entries[1].settlementReference)
        assertNull(seller.entries[2].status)
        assertEquals("CLAWED_BACK", seller.entries[2].statusLabel)
        assertEquals("chargeback", seller.entries[2].reversalReason)
        assertEquals(CommissionSettlementStatus.PAID, seller.settlements.single().status)
        assertEquals(1200, seller.settlements.single().amountMinor)
    }

    @Test
    fun `a sale accepts proof while finance has not finished with it`() {
        val page = gson.fromJson(
            """{"payouts":[
                 {"id":"w1","reference":"WDR-0001","username":"ali","amountRCoins":3150,"feeRCoins":150,
                  "netRCoins":3000,"status":"PENDING","receiptCount":0,"createdAt":"2026-11-01T00:00:00.000Z"},
                 {"id":"w2","reference":"WDR-0002","status":"APPROVED","receiptCount":1},
                 {"id":"w3","reference":"WDR-0003","status":"PAID","receiptCount":2},
                 {"id":"w4","reference":"WDR-0004","status":"REJECTED"},
                 {"id":"w5","reference":"WDR-0005","status":"ESCHEATED"}
               ],"total":5}""",
            SellerPayoutsEnvelope::class.java,
        ).toPayoutPage()

        assertEquals(5, page.total)
        assertTrue(page.payouts[0].acceptsReceipt)
        assertTrue(page.payouts[1].acceptsReceipt)
        assertFalse(page.payouts[2].acceptsReceipt)
        assertFalse(page.payouts[3].acceptsReceipt)
        assertFalse(page.payouts[4].acceptsReceipt)
        assertEquals(SellerPayoutStatus.PENDING, page.payouts[0].status)
        assertEquals(3000, page.payouts[0].netRCoins)
        assertEquals(150, page.payouts[0].feeRCoins)
        assertNull(page.payouts[4].status)
        assertEquals("ESCHEATED", page.payouts[4].statusLabel)
    }

    @Test
    fun `a duplicate upload is the server saying it already holds these bytes`() {
        val fresh = gson.fromJson(
            """{"receipt":{"id":"r1","fileName":"proof.png","byteSize":20480},"duplicate":false}""",
            ReceiptUploadEnvelope::class.java,
        ).toUploadedReceipt()!!
        assertFalse(fresh.duplicate)
        assertEquals("proof.png", fresh.fileName)
        assertEquals(20480, fresh.byteSize)

        val again = gson.fromJson(
            """{"receipt":{"id":"r1","fileName":"proof.png","byteSize":20480},"duplicate":true}""",
            ReceiptUploadEnvelope::class.java,
        ).toUploadedReceipt()!!
        assertTrue(again.duplicate)
        assertNull(gson.fromJson("{}", ReceiptUploadEnvelope::class.java).toUploadedReceipt())
    }

    @Test
    fun `a BD's territory carries each seller's own numbers`() {
        val rows = gson.fromJson(
            """{"sellers":[
                 {"id":"biz-seller","kind":"COIN_SELLER","code":"SLR-0001","displayName":"Corner Shop",
                  "status":"ACTIVE","marketCountry":"PK",
                  "recharge":{"orders":12,"credited":9,"processedDiamonds":90000,"netCollectedCents":147000}},
                 {"id":"biz-2","code":"SLR-0002","status":"SUSPENDED"}
               ]}""",
            PartnerSellersEnvelope::class.java,
        ).toSellerRows()

        assertEquals(2, rows.size)
        assertEquals(12, rows[0].recharge.orders)
        assertEquals(147000, rows[0].recharge.netCollectedMinor)
        assertEquals(PartnerAccountStatus.SUSPENDED, rows[1].status)
        assertEquals(0, rows[1].recharge.orders)
        assertTrue(gson.fromJson("{}", PartnerSellersEnvelope::class.java).toSellerRows().isEmpty())
    }

    @Test
    fun `a seller report is the seller's whole book, or nothing`() {
        val report = gson.fromJson(
            """{"seller":{"id":"biz-seller","kind":"COIN_SELLER","code":"SLR-0001","status":"ACTIVE"},
                "recharge":{"orders":12,"credited":9},
                "commission":{"accruedCents":4500,"currency":"pkr"},
                "entries":[{"orderReference":"RCH-0001","status":"ACCRUED","amountCents":500,"currency":"pkr"}],
                "settlements":[],
                "orders":[{"reference":"RCH-0001","status":"CREDITED"}]}""",
            SellerReportEnvelope::class.java,
        ).toSellerReport()!!

        assertEquals("SLR-0001", report.seller.code)
        assertEquals(9, report.recharge.credited)
        assertEquals(4500, report.commission.accruedMinor)
        assertEquals(1, report.entries.size)
        assertEquals(1, report.orders.size)
        assertTrue(report.settlements.isEmpty())
        assertNull(gson.fromJson("{}", SellerReportEnvelope::class.java).toSellerReport())
    }
}