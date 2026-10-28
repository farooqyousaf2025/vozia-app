package com.voiza.app.ui.screens.room

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.unit.em
import coil.compose.AsyncImage
import com.voiza.app.domain.model.EmojiOption
import com.voiza.app.ui.components.asAssetUrl

// ---------------------------------------------------------------------------
// Chat emoji drawn inside a message.
//
// A message stores the token `[smile]` and nothing else — the art is not part of
// the chat row — so showing it is a decision made at render time from the
// `emoji_characters` rows the operator maintains. Two consequences shape this file:
// a code with no row (retired, or typed by hand) is left exactly as written rather
// than blanked out, and the scanner is the `codePattern` the server publishes
// instead of a copy of it that could drift away from what the backend accepts.
// ---------------------------------------------------------------------------

/** A chat line split into text and the art its codes resolved to. */
class EmojiMessage(val text: AnnotatedString, val inlineContent: Map<String, InlineTextContent>)

/**
 * [content] with every known code replaced by its image.
 *
 * Pass the result to `BasicText(text = …, inlineContent = …)`; Material 3's `Text` has no
 * inline-content parameter, so a bubble that ignores this map silently shows the raw token.
 */
@Composable
fun rememberEmojiMessage(
    content: String,
    emojis: List<EmojiOption>,
    codePattern: String,
): EmojiMessage {
    val byCode = remember(emojis) { emojis.associateBy { it.code } }
    // The mapper only keeps a pattern that compiles, so this cannot throw.
    val scanner = remember(codePattern) { Regex(codePattern) }

    return remember(content, byCode, scanner) {
        val inline = mutableMapOf<String, InlineTextContent>()
        val text = buildAnnotatedString {
            var cursor = 0
            for (match in scanner.findAll(content)) {
                val option = byCode[match.value] ?: continue
                append(content.substring(cursor, match.range.first))
                appendInlineContent(option.code, option.label)
                inline[option.code] = emojiInlineContent(option)
                cursor = match.range.last + 1
            }
            append(content.substring(cursor))
        }
        EmojiMessage(text, inline)
    }
}

/**
 * One tile of art inside the text line. The placeholder is measured in `em`, so an emoji grows
 * with the bubble's font size instead of being pinned to a dp that only suits one of them, and
 * the image fills exactly the space that was reserved.
 *
 * Deliberately not `@Composable`: the map of tiles is built inside a `remember` calculation, which
 * is a plain lambda. Only the `children` body below runs as composable code, and that is expressed
 * by the parameter type rather than by an annotation here.
 */
private fun emojiInlineContent(option: EmojiOption): InlineTextContent {
    val box = 1.35.em
    return InlineTextContent(
        // This stack keeps the vertical alignment on the Placeholder rather than on the
        // InlineTextContent, and it has no default — without TextCenter the tile rides the
        // baseline and a two-line bubble shifts the art up or down by a few pixels.
        placeholder = Placeholder(width = box, height = box, placeholderVerticalAlign = PlaceholderVerticalAlign.TextCenter),
        children = {
            Box(Modifier.fillMaxSize()) {
                AsyncImage(
                    model = option.url.asAssetUrl(),
                    contentDescription = option.label,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        },
    )
}
