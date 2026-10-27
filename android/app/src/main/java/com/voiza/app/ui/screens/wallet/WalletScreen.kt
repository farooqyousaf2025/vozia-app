package com.voiza.app.ui.screens.wallet

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.Transaction
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.components.VoizaSheet
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.DiamondGold
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.RCoinGreen
import com.voiza.app.ui.theme.VoizaCtaGradient
import com.voiza.app.ui.theme.VoizaSurface
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.viewmodel.WalletViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * Wallet: diamond hero card + R-coin earnings card, recharge presets
 * (simulated purchase against /api/wallet/recharge), withdrawal sheet, and
 * the colour-coded transaction ledger.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WalletScreen(
    onBack: () -> Unit,
    viewModel: WalletViewModel = viewModel(
        factory = voizaViewModelFactory { WalletViewModel() },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var withdrawOpen by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 6.dp),
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = OnDarkHigh)
            }
            Text("Wallet", color = OnDarkHigh, fontSize = 19.sp, fontWeight = FontWeight.Bold)
        }

        val snapshot = state.snapshot
        val user = state.user

        // Recharge presets row (dev: simulated purchase).
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            RECHARGE_PRESETS.forEach { amount ->
                FilterChip(
                    selected = false,
                    onClick = { viewModel.recharge(amount) },
                    enabled = state.busyAction != WalletViewModel.WalletUiState.BusyAction.RECHARGE,
                    label = { Text("+$amount \u2756", fontSize = 12.sp) },
                    colors = FilterChipDefaults.filterChipColors(
                        containerColor = VoizaSurfaceHigh,
                        labelColor = DiamondGold,
                    ),
                )
            }
        }

        LazyColumn(
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        ) {
            item {
                HeroBalanceCard(
                    diamonds = user?.diamondBalance,
                    rCoins = user?.rCoinBalance,
                    onWithdraw = { withdrawOpen = true },
                )
            }
            item {
                StatsCard(
                    diamondsSpent = snapshot?.stats?.diamondsSpent ?: 0,
                    rCoinsEarned = snapshot?.stats?.rCoinsEarned ?: 0,
                    giftsSent = snapshot?.stats?.giftsSent ?: 0,
                )
            }
            item {
                Text(
                    text = "Transactions",
                    color = OnDarkHigh,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }

            val txns = snapshot?.transactions.orEmpty()
            if (state.loading && txns.isEmpty()) {
                item { LoadingProgress(modifier = Modifier.height(120.dp).fillMaxWidth()) }
            } else if (txns.isEmpty()) {
                item {
                    Text(
                        "No transactions yet. Send a gift or top up diamonds.",
                        color = OnDarkMedium,
                        fontSize = 13.sp,
                    )
                }
            } else {
                items(txns, key = { it.id }) { txn ->
                    TransactionRow(txn)
                }
            }
        }

        state.message?.let { msg ->
            LaunchedMessage(text = msg, onConsumed = viewModel::consumeMessage)
        }
        state.error?.let { err ->
            Text(
                text = err,
                color = DangerRed,
                fontSize = 12.sp,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
        }
    }

    if (withdrawOpen) {
        WithdrawSheet(
            rCoinBalance = state.user?.rCoinBalance ?: 0,
            busy = state.busyAction == WalletViewModel.WalletUiState.BusyAction.WITHDRAW,
            onDismiss = { withdrawOpen = false },
            onSubmit = { amount, method, account ->
                viewModel.withdraw(amount, method, mapOf("account" to account))
                withdrawOpen = false
            },
        )
    }
}

private val RECHARGE_PRESETS = listOf(100, 500, 1000, 5000, 10000)

@Composable
private fun HeroBalanceCard(
    diamonds: Int?,
    rCoins: Int?,
    onWithdraw: () -> Unit,
) {
    VoizaCard(
        modifier = Modifier.fillMaxWidth(),
        backgroundColor = Color.Transparent,
        contentPadding = 0.dp,
    ) {
        Column(
            modifier = Modifier
                .clip(RoundedCornerShape(20.dp))
                .background(
                    Brush.verticalGradient(
                        listOf(
                            Color(0xFF6A3BE8),
                            Color(0xFFB02FD6),
                            Color(0xFF22D3EE),
                        )
                    )
                )
                .padding(20.dp),
        ) {
            Text("\u2756 Diamonds", color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            Text(
                text = diamonds?.toString() ?: "--",
                color = OnDarkHigh,
                fontSize = 38.sp,
                fontWeight = FontWeight.Black,
            )
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(34.dp)
                        .clip(CircleShape)
                        .background(Color(0x33000000)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("\u25C9", color = RCoinGreen, fontSize = 16.sp)
                }
                Spacer(Modifier.width(10.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text("R-Coins (host earnings)", color = OnDarkHigh.copy(alpha = 0.85f), fontSize = 11.sp)
                    Text(rCoins?.toString() ?: "--", color = RCoinGreen, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                }
                VoizaButton(
                    text = "Withdraw",
                    onClick = onWithdraw,
                    gradient = Brush.horizontalGradient(listOf(Color(0xFF1B1140), Color(0xFF2A2459))),
                    height = 40,
                    modifier = Modifier.width(130.dp),
                )
            }
        }
    }
}

@Composable
private fun StatsCard(diamondsSpent: Long, rCoinsEarned: Long, giftsSent: Long) {
    VoizaCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            horizontalArrangement = Arrangement.SpaceBetween,
            modifier = Modifier.fillMaxWidth(),
        ) {
            StatColumn("Diamonds spent", diamondsSpent.toString(), DiamondGold)
            StatColumn("R-Coins earned", rCoinsEarned.toString(), RCoinGreen)
            StatColumn("Gifts sent", giftsSent.toString(), Fuchsia)
        }
    }
}

@Composable
private fun StatColumn(label: String, value: String, valueColor: Color) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, color = valueColor, fontSize = 20.sp, fontWeight = FontWeight.Black)
        Text(label, color = OnDarkMedium, fontSize = 11.sp)
    }
}

@Composable
private fun TransactionRow(txn: Transaction) {
    val outgoing = txn.type == "GIFT_SENT" || txn.type == "WITHDRAWAL"
    val incoming = txn.type == "RECHARGE"
    VoizaCard(
        modifier = Modifier.fillMaxWidth(),
        backgroundColor = VoizaSurface,
        contentPadding = 12.dp,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .background(
                        when {
                            incoming -> Color(0x3366E0A3)
                            outgoing -> Color(0x33FF5B6E)
                            else -> VoizaSurfaceHigh
                        }
                    ),
            ) {
                Text(
                    text = when (txn.type) {
                        "GIFT_SENT" -> "\uD83C\uDF81"
                        "RECHARGE" -> "\u2756"
                        "WITHDRAWAL" -> "\u2192"
                        else -> "\u00B7"
                    },
                    color = OnDarkHigh,
                    fontSize = 15.sp,
                )
            }
            Spacer(Modifier.width(10.dp))
            Column(modifier = Modifier.weight(1f)) {
                val who = txn.sender?.username ?: txn.receiver?.username
                Text(
                    text = when (txn.type) {
                        "GIFT_SENT" -> "${txn.giftName ?: "Gift"}${who?.let { " \u2192 $it" } ?: ""}"
                        "RECHARGE" -> "Diamond top-up"
                        "WITHDRAWAL" -> "Withdrawal"
                        else -> txn.type.lowercase().replace('_', ' ')
                    },
                    color = OnDarkHigh,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = txn.createdAt.take(16).replace('T', ' '),
                    color = OnDarkMedium,
                    fontSize = 10.sp,
                )
            }
            Text(
                text = when {
                    txn.amountDiamonds > 0 -> (if (incoming) "+" else "-") + "${txn.amountDiamonds} \u2756"
                    txn.amountRCoins > 0 -> "+${txn.amountRCoins} \u25C9"
                    else -> "0"
                },
                color = if (outgoing) Color(0xFFFF8FA0) else RCoinGreen,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WithdrawSheet(
    rCoinBalance: Int,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSubmit: (amount: Int, method: String, account: String) -> Unit,
) {
    var amountText by remember { mutableStateOf("") }
    var method by remember { mutableStateOf("BANK") }
    var account by remember { mutableStateOf("") }

    VoizaSheet(visible = true, onDismiss = onDismiss, title = "Withdraw R-Coins") {
        Text(
            text = "Available: $rCoinBalance \u25C9",
            color = RCoinGreen,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = amountText,
            onValueChange = { amountText = it.filter { c -> c.isDigit() }.take(9) },
            label = { Text("Amount in R-Coins", fontSize = 13.sp) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true,
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Cyan,
                unfocusedBorderColor = Color(0xFF3D3670),
                focusedTextColor = OnDarkHigh,
                unfocusedTextColor = OnDarkHigh,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("BANK", "UPI", "PAYPAL").forEach { m ->
                FilterChip(
                    selected = method == m,
                    onClick = { method = m },
                    label = { Text(m, fontSize = 12.sp) },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = VoizaSurfaceHigh,
                        containerColor = Color(0xFF1B1740),
                        labelColor = OnDarkMedium,
                        selectedLabelColor = OnDarkHigh,
                    ),
                )
            }
        }
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = account,
            onValueChange = { account = it.take(80) },
            label = { Text("Payout account / details", fontSize = 13.sp) },
            singleLine = true,
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Cyan,
                unfocusedBorderColor = Color(0xFF3D3670),
                focusedTextColor = OnDarkHigh,
                unfocusedTextColor = OnDarkHigh,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(14.dp))
        VoizaButton(
            text = if (busy) "Submitting\u2026" else "Request withdrawal",
            enabled = !busy &&
                amountText.toIntOrNull() != null &&
                (amountText.toIntOrNull() ?: 0) > 0 &&
                account.isNotBlank(),
            onClick = { onSubmit(amountText.toInt(), method, account) },
            gradient = VoizaCtaGradient,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** One-shot confirmation snack; clears itself after 2.5 s. */
@Composable
private fun LaunchedMessage(text: String, onConsumed: () -> Unit) {
    androidx.compose.runtime.LaunchedEffect(text) {
        kotlinx.coroutines.delay(2500)
        onConsumed()
    }
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
        Text(
            text = text,
            color = OnDarkHigh,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .clip(RoundedCornerShape(10.dp))
                .background(Color(0xE6221B4E))
                .padding(horizontal = 14.dp, vertical = 8.dp),
        )
    }
}
