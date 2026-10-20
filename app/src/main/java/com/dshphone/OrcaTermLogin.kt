package com.dshphone

import android.net.Uri
import android.content.Context
import android.content.Intent
import android.content.ActivityNotFoundException
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.widget.Toast
import org.json.JSONObject

/** 腾讯云网页登录态通过现有登录窗口交回发起登录的本机页面。 */
object OrcaTermLogin {
    fun openWeChat(context: Context, view: WebView, request: WebResourceRequest): Boolean {
        if (!OrcaTermWeChatNavigation.shouldOpen(view.url, request.url.toString(), request.isForMainFrame)) return false
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, request.url).setPackage("com.tencent.mm"))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(context, "未能打开微信，请安装微信后重试或选择扫码登录", Toast.LENGTH_LONG).show()
        }
        return true
    }

    fun start(account: String, url: String, open: () -> WebView,
              active: (WebView) -> Boolean, deliver: (String) -> Unit) {
        val uri = Uri.parse(url)
        if (account.isBlank() || uri.scheme != "https" ||
            uri.host != "orcaterm.cloud.tencent.com" || uri.userInfo != null ||
            (uri.port != -1 && uri.port != 443)) return
        val tab = open()
        // 与 multiweb 的网页登录窗口保持相同浏览器标识。
        tab.settings.userAgentString = tab.settings.userAgentString
            .replace("; wv", "").replace("Version/4.0 ", "")
        tab.loadUrl(url)
        val deadline = System.currentTimeMillis() + 300_000
        val poll = object : Runnable {
            override fun run() {
                if (!active(tab)) return
                val cookie = CookieManager.getInstance().getCookie(url).orEmpty()
                val fields = cookie.split(';').map { it.trim() }
                val webSession = listOf("uin", "skey").all { name -> fields.any {
                        it.startsWith("$name=") && it.substringAfter('=').isNotBlank()
                    } }
                val otSession = fields.firstOrNull { it.startsWith("ot_session=") }
                    ?.substringAfter('=').orEmpty()
                if (webSession || (otSession.startsWith("eyJ") && otSession.split('.').size == 3)) {
                    CookieManager.getInstance().flush()
                    deliver(JSONObject().put("accountId", account).put("value", cookie).toString())
                    return
                }
                if (System.currentTimeMillis() < deadline) tab.postDelayed(this, 1500)
            }
        }
        tab.postDelayed(poll, 1500)
    }
}
