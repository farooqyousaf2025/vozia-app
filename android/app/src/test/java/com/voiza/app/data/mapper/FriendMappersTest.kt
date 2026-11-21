package com.voiza.app.data.mapper

import com.google.gson.Gson
import com.voiza.app.data.remote.dto.FriendRequestDto
import com.voiza.app.domain.model.FriendRequestStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Friends and DMs share the rule the rest of the mapper tests pin: Gson does not run constructors,
 * so a key the server omitted arrives as null and must be handled here rather than in a default.
 */
class FriendMappersTest {

    private val gson = Gson()

    private val parties = """"requester":{"id":"r1","username":"Ana","avatarUrl":null},"addressee":{"id":"me","username":"Me","avatarUrl":null}"""

    @Test
    fun `a request without both parties is dropped rather than drawn as a blank card`() {
        val noAddressee = gson.fromJson(
            """{"id":"q1","status":"PENDING","createdAt":"2026-11-01T00:00:00.000Z","requester":{"id":"r1","username":"Ana"}}""",
            FriendRequestDto::class.java,
        )
        assertNull(noAddressee.toDomainOrNull())
    }

    @Test
    fun `a pending request keeps the sides the server resolved`() {
        val request = gson.fromJson(
            """{"id":"q1","status":"PENDING","createdAt":"2026-11-01T00:00:00.000Z","respondedAt":null,$parties}""",
            FriendRequestDto::class.java,
        ).toDomainOrNull()

        assertNotNull(request)
        assertEquals(FriendRequestStatus.PENDING, request!!.status)
        assertEquals("Pending", request.statusLabel)
        assertTrue(request.isIncoming("me"))
        assertFalse(request.isIncoming("r1"))
        assertEquals("r1", request.otherParty("me").id)
        assertEquals("me", request.otherParty("r1").id)
    }

    @Test
    fun `a status this build does not know is shown as the server word`() {
        val request = gson.fromJson(
            """{"id":"q2","status":"BLOCKED","createdAt":"2026-11-01T00:00:00.000Z",$parties}""",
            FriendRequestDto::class.java,
        ).toDomainOrNull()

        assertNotNull(request)
        assertNull(request!!.status)
        assertEquals("BLOCKED", request.statusLabel)
    }

    @Test
    fun `a conversation with a negative unread count cannot show a negative badge`() {
        val conversation = gson.fromJson(
            """{"id":"c1","unreadCount":-4,"partner":{"id":"p1","username":"Bo"},"lastMessageAt":"2026-11-20T12:00:00.000Z","lastMessagePreview":"See you in the room"}""",
            com.voiza.app.data.remote.dto.ConversationDto::class.java,
        ).toDomainOrNull()

        assertNotNull(conversation)
        assertEquals(0, conversation!!.unreadCount)
        assertEquals("Bo", conversation.partner.username)
        assertEquals("See you in the room", conversation.lastMessagePreview)
    }

    @Test
    fun `a message the server did not attribute to a sender is dropped`() {
        val message = gson.fromJson(
            """{"id":"m1","conversationId":"c1","content":"hi","createdAt":"2026-11-01T00:00:00.000Z"}""",
            com.voiza.app.data.remote.dto.DirectMessageDto::class.java,
        )
        assertNull(message.toDomainOrNull())
    }

    @Test
    fun `the request statuses are the three words the server can write`() {
        assertEquals(
            listOf("PENDING", "ACCEPTED", "DECLINED"),
            FriendRequestStatus.entries.map { it.wire },
        )
        assertEquals(FriendRequestStatus.ACCEPTED, FriendRequestStatus.fromWire(" accepted "))
        assertNull(FriendRequestStatus.fromWire("RETRACTED"))
    }
}
