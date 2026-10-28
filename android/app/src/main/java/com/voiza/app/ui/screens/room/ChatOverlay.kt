package com.voiza.app.ui.screens.room

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.EmojiEmotions
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.voiza.app.domain.model.ChatMessage
import com.voiza.app.domain.model.EmojiOption
import com.voiza.app.domain.model.FALLBACK_EMOJI_CODE_PATTERN
import com.voiza.app.domain.model.MessageType
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.asAssetUrl
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.GiftPink
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.VoizaSurfaceHigh

/**
 * Semi-transparent chat feed: a compact overlay window (~6 rows tall) with an
 * auto-scrolling list and input row. GIFT/SYSTEM lines are highlighted.
 *
 * The emoji strip is the picker for the codes an operator maintains in the admin panel: tapping a
 * tile inserts its `[code]` into the draft, because that token, not the picture, is what the
 * message will store and what everyone else's client will draw art for.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatOverlay(
    messages: List<ChatMessage>,
    onSend: (String) -> Unit,
    modifier: Modifier = Modifier,
    emojis: List<EmojiOption> = emptyList(),
    codePattern: String = FALLBACK_EMOJI_CODE_PATTERN,
) {
    val listState = rememberLazyListState()
    var input by remember { mutableStateOf("") }
    var pickerOpen by remember { mutableStateOf(false) }

    // Keep pinned to the newest message.
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) {
            listState.animateScrollToItem((messages.size - 1).coerceAtLeast(0))
        }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LazyColumn(
            state = listState,
            reverseLayout = false,
            contentPadding = PaddingValues(vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier
                .fillMaxWidth()
                .height(168.dp) // ~6 visible rows
                .clip(RoundedCornerShape(14.dp))
                .background(Color(0x400B0A1F)),
        ) {
            items(messages, key = { it.id }) { msg ->
                ChatRow(msg, emojis, codePattern)
            }
        }

        if (pickerOpen && emojis.isNotEmpty()) {
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                contentPadding = PaddingValues(horizontal = 4.dp, vertical = 2.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(Color(0x590B0A1F)),
            ) {
                items(emojis, key = { it.key }) { option ->
                    EmojiTile(option) { input = (input + option.code).take(MAX_INPUT) }
                }
            }
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it.take(MAX_INPUT) },
                placeholder = { Text("Say something\u2026", fontSize = 13.sp, color = OnDarkMedium) },
                singleLine = true,
                shape = RoundedCornerShape(14.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Fuchsia.copy(alpha = 0.7f),
                    unfocusedBorderColor = Color(0xFF3D3670),
                    cursorColor = Cyan,
                    focusedTextColor = OnDarkHigh,
                    unfocusedTextColor = OnDarkHigh,
                    focusedContainerColor = Color(0x66231F4E),
                    unfocusedContainerColor = Color(0x66231F4E),
                ),
                modifier = Modifier
                    .weight(1f),
            )
            IconButton(onClick = { pickerOpen = !pickerOpen }) {
                Icon(
                    imageVector = Icons.Default.EmojiEmotions,
                    contentDescription = if (pickerOpen) "Hide emoji" else "Pick emoji",
                    tint = if (pickerOpen) Cyan else OnDarkMedium,
                )
            }
            IconButton(
                onClick = {
                    if (input.isNotBlank()) {
                        onSend(input)
                        input = ""
                    }
                },
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.Send,
                    contentDescription = "Send",
                    tint = if (input.isNotBlank()) Cyan else OnDarkMedium,
                )
            }
        }
    }
}

private const val MAX_INPUT = 300

/** One picker tile: the operator's art, tappable, labelled for TalkBack with the row's own name. */
@Composable
private fun EmojiTile(option: EmojiOption, onPick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(44.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(Color(0x33FFFFFF))
            .clickable(onClick = onPick),
        contentAlignment = Alignment.Center,
    ) {
        AsyncImage(
            model = option.url.asAssetUrl(),
            contentDescription = option.label,
            contentScale = ContentScale.Fit,
            modifier = Modifier.padding(5.dp).fillMaxSize(),
        )
    }
}

@Composable
private fun ChatRow(
    msg: ChatMessage,
    emojis: List<EmojiOption>,
    codePattern: String,
) {
    val isGift = msg.type == MessageType.GIFT
    val isSystem = msg.type == MessageType.SYSTEM
    val bubbleShape = RoundedCornerShape(12.dp)
    // Only a member's own words carry codes; gift and system lines are written by the server.
    val line = rememberEmojiMessage(msg.content, if (isGift || isSystem) emptyList() else emojis, codePattern)

    Box(
        modifier = Modifier
            .padding(horizontal = 8.dp, vertical = 1.dp)
            .clip(bubbleShape)
            .background(
                when {
                    isGift -> Color(0x40FF6EC7)
                    isSystem -> Color(0x3322D3EE)
                    else -> Color(0x26000000)
                }
            ),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.Top,
        ) {
            if (!isSystem && msg.user != null) {
                Avatar(url = msg.user.avatarUrl, name = msg.user.username, size = 22.dp)
                Box(modifier = Modifier.width(8.dp), content = {})
            }
            Column(modifier = Modifier.weight(1f, fill = false)) {
                if (!isSystem && msg.user != null) {
                    Text(
                        text = msg.user.username,
                        color = if (isGift) GiftPink else Cyan,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
                BasicText(
                    text = line.text,
                    inlineContent = line.inlineContent,
                    style = TextStyle(
                        color = OnDarkHigh,
                        fontSize = 12.sp,
                        fontWeight = if (isGift) FontWeight.SemiBold else FontWeight.Normal,
                    ),
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (isGift) {
                Icon(
                    imageVector = Icons.Default.CardGiftcard,
                    contentDescription = null,
                    tint = GiftPink,
                    modifier = Modifier
                        .padding(start = 6.dp)
                        .size(14.dp),
                )
            }
        }
    }
}
