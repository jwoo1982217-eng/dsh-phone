package com.dshphone

import android.content.Intent
import android.net.Uri
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ConversationShareTest {
    private fun uri(text: String) = Uri.parse("dsh-phone://conversation/share?text=" + Uri.encode(text))
    @Test fun onlyOpensChooserWithExactTextAndNoRecipient() {
        val result = ConversationShare.intent("http://127.0.0.1:3080/", uri("正文🙂\n第二行"), true)!!
        assertEquals(Intent.ACTION_CHOOSER, result.action)
        val send = result.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals("text/plain", send.type)
        assertEquals("正文🙂\n第二行", send.getStringExtra(Intent.EXTRA_TEXT))
        assertNull(send.`package`); assertNull(send.component); assertNull(send.data)
    }
    @Test fun rejectsUntrustedSourcesSubframesAndLargeOrEmptyPayloads() {
        for (source in listOf("https://evil.test", "http://127.0.0.1:3082/", "http://user@127.0.0.1:3080/", "file:///tmp/a")) {
            assertNull(ConversationShare.intent(source, uri("x"), true))
        }
        assertNull(ConversationShare.intent("http://127.0.0.1:3080/", uri("x"), false))
        assertNull(ConversationShare.intent("http://127.0.0.1:3080/", uri(" "), true))
        assertNull(ConversationShare.intent("http://127.0.0.1:3080/", uri("x".repeat(65537)), true))
        assertNotNull(ConversationShare.intent("http://127.0.0.1:3081/", uri("消息"), true))
    }
}
