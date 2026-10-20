package com.dshphone

import android.content.Intent
import android.net.Uri

/** Opens a chooser only; it never selects a recipient or grants filesystem access. */
internal object ConversationShare {
    fun intent(source: String?, target: Uri, mainFrame: Boolean): Intent? {
        val page = runCatching { Uri.parse(source.orEmpty()) }.getOrNull() ?: return null
        if (!mainFrame || page.scheme != "http" || page.host != "127.0.0.1" ||
            page.userInfo != null || page.port !in listOf(NodeRunner.WEB_PORT, 3081) ||
            target.scheme != "dsh-phone" || target.host != "conversation" ||
            target.path != "/share" || target.userInfo != null || target.fragment != null) return null
        val text = target.getQueryParameter("text") ?: return null
        if (text.isBlank() || text.length > 65536 || text.toByteArray(Charsets.UTF_8).size > 196608) return null
        return Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
        }, "分享消息正文")
    }
}
