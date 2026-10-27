package com.dshphone.browser

import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.*
import android.util.Base64
import android.view.KeyEvent
import android.view.View
import androidx.webkit.*
import android.webkit.*
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.util.UUID

/** Dedicated WebView process/profile, scoped tabs, no arbitrary JS or native JS interface. */
class BrowserService : Service() {
    companion object {
        var current: BrowserService? = null; private set
        private var profileSet = false
    }
    data class Tab(val id: String, val owner: String, val view: WebView,
        val cssWidth: Int = 1080, val cssHeight: Int = 1600, val identity: String = "android-real",
        var effectiveIdentity: String = "android-real", var profileNote: String = "", var documentStart: Boolean = false,
        var ready: Boolean = false, var error: String? = null, var rendererGone: Boolean = false,
        var lastUrl: String = "", var viewport: JSONObject? = null)
    private val tabs = linkedMapOf<String, Tab>()
    private val active = linkedMapOf<String, String>()
    private val queues = linkedSetOf<String>()
    private val handler = Handler(Looper.getMainLooper())
    private val domScript by lazy { assets.open("dsh-browser-dom.js").bufferedReader().use { it.readText() } }
    private val messenger = Messenger(object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(message: Message) {
            if (message.sendingUid != android.os.Process.myUid() || message.what != 1) return
            val id = message.data.getString("id") ?: return
            val reply = message.replyTo ?: return
            val finish: (JSONObject?, Throwable?) -> Unit = { value, error ->
                val response = if (error == null) JSONObject().put("ok", true).put("value", value)
                    else JSONObject().put("ok", false).put("error", error.message ?: "浏览器操作失败")
                runCatching { reply.send(Message.obtain(null, 1).apply { data = Bundle().apply { putString("id", id); putString("json", response.toString()) } }) }
            }
            try {
                val request = JSONObject(message.data.getString("json") ?: "{}")
                val owner = request.getString("owner")
                require(owner.matches(Regex("[a-zA-Z0-9_-]{1,128}"))) { "浏览器窗口无效" }
                check(queues.add(owner)) { "该窗口上一浏览器操作尚未结束" }
                var settled = false
                val complete: (JSONObject?, Throwable?) -> Unit = { result, error ->
                    if (!settled) { settled = true; queues.remove(owner); finish(result, error) }
                }
                handler.postDelayed({ complete(null, IllegalStateException("页面加载超时，当前标签仍保留，请先读取状态")) }, 16_000)
                try { call(owner, request.getString("method"), request.optJSONObject("args") ?: JSONObject(), complete) }
                catch (error: Throwable) { complete(null, error) }
            } catch (error: Throwable) { finish(null, error) }
        }
    })
    override fun onCreate() {
        super.onCreate()
        if (!profileSet) { WebView.setDataDirectorySuffix("dsh_tool_browser"); profileSet = true }
        current = this
    }
    override fun onBind(intent: Intent?): IBinder = messenger.binder
    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null); queues.clear()
        current = null; tabs.values.forEach { if (!it.rendererGone) it.view.destroy() }; tabs.clear()
        super.onDestroy()
    }
    private fun validUrl(value: String): String {
        val uri = Uri.parse(value)
        require(uri.scheme in listOf("http", "https") && !uri.host.isNullOrBlank() && uri.userInfo == null) { "只允许HTTP/HTTPS网页" }
        return uri.toString()
    }
    @Suppress("SetJavaScriptEnabled")
    private fun buildTab(owner: String, id: String, url: String, width: Int, height: Int, identity: String, saved: Bundle? = null): Tab {
        BrowserProfilePolicy.validate(width,height,identity)
        val target = validUrl(url)
        val view = WebView(this)
        val tab = Tab(id,owner,view,width,height,identity,lastUrl=target)
        try {
            view.settings.apply {
                javaScriptEnabled = true; domStorageEnabled = true
                allowFileAccess = false; allowContentAccess = false
                javaScriptCanOpenWindowsAutomatically = false; setSupportMultipleWindows(false)
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                useWideViewPort = true; loadWithOverviewMode = true
            }
            if (identity == "windows-desktop") {
                if (WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) {
                    val original = view.settings.userAgentString
                    val full = BrowserProfilePolicy.chromeVersion(original)
                    val brand = UserAgentMetadata.BrandVersion.Builder().setBrand("Chromium").setMajorVersion(full.substringBefore('.')).setFullVersion(full).build()
                    WebSettingsCompat.setUserAgentMetadata(view.settings,UserAgentMetadata.Builder()
                        .setBrandVersionList(listOf(brand)).setFullVersion(full).setPlatform("Windows")
                        .setPlatformVersion("10.0.0").setArchitecture("x86").setModel("").setMobile(false).setBitness(64).setWow64(false).build())
                    view.settings.userAgentString = BrowserProfilePolicy.desktopUa(original)
                    tab.effectiveIdentity = identity
                } else tab.profileNote = "此WebView不支持一致的桌面UA-CH，保留手机身份"
            }
            val viewportScript = BrowserProfilePolicy.viewportScript(width)
            tab.documentStart = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
            if (tab.documentStart) WebViewCompat.addDocumentStartJavaScript(view,viewportScript,setOf("*"))
            else tab.profileNote += "；此WebView仅支持页面加载后调整视口"
            view.setLayerType(View.LAYER_TYPE_SOFTWARE,null)
            size(view,width,height)
            view.webViewClient = object : WebViewClient() {
                override fun onPageStarted(v: WebView?, url: String?, icon: Bitmap?) {
                    tab.ready = false; tab.error = null; tab.viewport = null
                    if (url != null) tab.lastUrl = url
                }
                override fun onPageFinished(v: WebView?, url: String?) {
                    if (tab.rendererGone) return
                    tab.ready = true
                    val probe = "JSON.stringify({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,userAgent:navigator.userAgent})"
                    view.evaluateJavascript((if (tab.documentStart) "" else viewportScript+";")+probe) { raw ->
                        if (tabs[tab.id] !== tab || tab.rendererGone) return@evaluateJavascript
                        tab.viewport = runCatching { JSONObject(JSONTokener(raw).nextValue().toString()) }.getOrNull()
                    }
                }
                override fun onReceivedError(v: WebView?, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) tab.error = error.description?.toString() ?: "网页加载失败"
                }
                override fun onReceivedHttpError(v: WebView?, request: WebResourceRequest, response: WebResourceResponse) {
                    if (request.isForMainFrame && response.statusCode >= 400) tab.error = "HTTP ${response.statusCode}"
                }
                override fun onRenderProcessGone(v: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                    tab.ready = false; tab.rendererGone = true; tab.error = "网页渲染进程退出，请手动重新加载；未重放点击或提交"
                    (view.parent as? android.view.ViewGroup)?.removeView(view); view.destroy(); return true
                }
                override fun shouldOverrideUrlLoading(v: WebView?, request: WebResourceRequest): Boolean = runCatching { validUrl(request.url.toString()); false }.getOrDefault(true)
            }
            view.setDownloadListener { _,_,_,_,_ -> }
            if (saved == null || view.restoreState(saved) == null) view.loadUrl(target) else view.reload()
            return tab
        } catch (error: Throwable) { view.destroy(); throw error }
    }
    private fun size(view: WebView, width: Int, height: Int) {
        val density = resources.displayMetrics.density
        val rect = BrowserProfilePolicy.fit(1080,1600,width,height,density.toDouble())
        view.measure(View.MeasureSpec.makeMeasureSpec(rect[2],View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(rect[3],View.MeasureSpec.EXACTLY))
        view.layout(0,0,rect[2],rect[3])
    }
    private fun newTab(owner: String, args: JSONObject): Tab {
        check(tabs.size < 16) { "请先关闭不用的标签页" }
        val tab = buildTab(owner,UUID.randomUUID().toString(),args.getString("url"),args.optInt("viewportWidth",1080),args.optInt("viewportHeight",1600),args.optString("identity","android-real"))
        tabs[tab.id] = tab; active[owner] = tab.id; return tab
    }
    private fun replace(tab: Tab,args: JSONObject): Tab {
        val state = if (!tab.rendererGone) Bundle().also { tab.view.saveState(it) } else null
        val next = buildTab(tab.owner,tab.id,tab.lastUrl,args.optInt("viewportWidth",tab.cssWidth),args.optInt("viewportHeight",tab.cssHeight),args.optString("identity",tab.identity),state)
        tabs[tab.id] = next
        (tab.view.parent as? android.view.ViewGroup)?.removeView(tab.view)
        if (!tab.rendererGone) tab.view.destroy()
        return next
    }
    fun select(owner: String,id: String) {
        check(tabs[id]?.owner == owner) { "标签页不属于当前窗口" }; active[owner] = id
    }
    fun profile(owner: String,id: String): Pair<Int,Int>? = tabs[id]?.takeIf { it.owner == owner }?.let { it.cssWidth to it.cssHeight }
    fun status(owner: String): JSONObject = JSONObject().put("active",active[owner] ?: JSONObject.NULL).put("tabs",JSONArray(tabs.values.filter { it.owner == owner }.map {
        JSONObject().put("id",it.id).put("url",if (it.rendererGone) it.lastUrl else it.view.url ?: it.lastUrl)
            .put("title",if(it.rendererGone) "网页已退出" else it.view.title ?: "").put("ready",it.ready).put("error",it.error ?: JSONObject.NULL)
            .put("viewportWidth",it.cssWidth).put("viewportHeight",it.cssHeight).put("identity",it.identity)
            .put("effectiveIdentity",it.effectiveIdentity).put("profileNote",it.profileNote).put("documentStart",it.documentStart)
            .put("viewportObserved",it.viewport ?: JSONObject.NULL).put("rendererGone",it.rendererGone)
    }))
    fun view(owner: String, id: String?): WebView? {
        val tab = tabs[id ?: active[owner]] ?: return null
        return if (tab.owner == owner && !tab.rendererGone) tab.view else null
    }
    private fun awaitPage(tab: Tab, complete: (JSONObject?, Throwable?) -> Unit, deadline: Long = SystemClock.elapsedRealtime() + 15_000, done: () -> Unit) {
        if (tabs[tab.id] !== tab || tab.rendererGone || SystemClock.elapsedRealtime() > deadline) {
            complete(null, IllegalStateException("标签关闭或页面超时，请先读取状态")); return
        }
        if (tab.ready) {
            try { done() } catch(error: Throwable) { complete(null, error) }
        } else handler.postDelayed({ awaitPage(tab, complete, deadline, done) }, 100)
    }
    private fun evaluate(tab: Tab, expression: String, complete: (JSONObject?, Throwable?) -> Unit) {
        awaitPage(tab, complete) {
            tab.view.evaluateJavascript(expression) { raw ->
                try {
                    check(tabs[tab.id] === tab && !tab.rendererGone) { "标签页已变化，请重新读取" }
                    val parsed = JSONTokener(raw).nextValue()
                    val value = if (parsed is String) JSONObject(parsed) else if (parsed is JSONObject) parsed else JSONObject().put("result", parsed)
                    check(!value.has("error")) { value.optString("error") }
                    complete(value, null)
                } catch (error: Throwable) { complete(null, error) }
            }
        }
    }
    fun call(owner: String, method: String, args: JSONObject, complete: (JSONObject?, Throwable?) -> Unit) {
        if (method == "status") { complete(status(owner), null); return }
        if (method == "open") {
            val tab = newTab(owner,args)
            awaitPage(tab, complete) { complete(status(owner), null) }; return
        }
        val id = args.optString("tabId", active[owner] ?: "")
        val tab = tabs[id] ?: error("标签页不存在")
        check(tab.owner == owner) { "标签页不属于当前窗口" }
        if (method == "select") { select(owner,id); complete(status(owner),null); return }
        if (method == "profile" || (method == "reload" && tab.rendererGone)) {
            // Reapplying the current viewport must keep the live document and forms.
            // An exited renderer still needs replacement even when its profile matches.
            if (method == "profile" && !tab.rendererGone &&
                args.optInt("viewportWidth",tab.cssWidth) == tab.cssWidth &&
                args.optInt("viewportHeight",tab.cssHeight) == tab.cssHeight &&
                args.optString("identity",tab.identity) == tab.identity) {
                complete(status(owner),null); return
            }
            val next = replace(tab,args); awaitPage(next,complete) { complete(status(owner),null) }; return
        }
        check(!tab.rendererGone || method == "close") { tab.error ?: "网页渲染进程已退出" }
        when (method) {
            "close" -> {
                (tab.view.parent as? android.view.ViewGroup)?.removeView(tab.view); if (!tab.rendererGone) tab.view.destroy(); tabs.remove(id)
                active[owner] = tabs.values.lastOrNull { it.owner == owner }?.id ?: ""
                complete(status(owner), null)
            }
            "read" -> evaluate(tab, domScript + ";JSON.stringify(window.__dshBrowserDom.snapshot())", complete)
            "click", "type" -> {
                check(tab.ready) { "网页尚未加载完，请先读取状态" }
                val selector = args.getString("selector"); require(selector.length <= 1000) { "选择器过长" }
                val arguments = if (method == "click") JSONObject.quote(selector) else {
                    val text = args.getString("text"); require(text.length <= 24000) { "文字过长" }
                    JSONObject.quote(selector) + "," + JSONObject.quote(text)
                }
                evaluate(tab, domScript + ";JSON.stringify(Object.assign(window.__dshBrowserDom." + method + "(" + arguments + "),{tabId:" + JSONObject.quote(id) + "}))", complete)
            }
            "press" -> {
                check(tab.ready) { "网页尚未加载完，请先读取状态" }
                val key = args.getString("key")
                val code = mapOf("Enter" to KeyEvent.KEYCODE_ENTER, "Tab" to KeyEvent.KEYCODE_TAB, "Backspace" to KeyEvent.KEYCODE_DEL, "Escape" to KeyEvent.KEYCODE_ESCAPE)[key] ?: error("暂支持Enter、Tab、Backspace、Escape")
                tab.view.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code)); tab.view.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
                complete(JSONObject().put("ok", true).put("tabId", id), null)
            }
            "screenshot" -> awaitPage(tab, complete) {
                val bitmap = Bitmap.createBitmap(tab.view.width.coerceAtLeast(1),tab.view.height.coerceAtLeast(1),Bitmap.Config.ARGB_8888); tab.view.draw(Canvas(bitmap))
                val bytes = ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.JPEG, 65, bytes); bitmap.recycle()
                check(bytes.size() < 300_000) { "截图过大，请先滚动到较简单的页面" }
                complete(JSONObject().put("mimeType", "image/jpeg").put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)).put("viewportObserved",tab.viewport ?: JSONObject.NULL).put("width",tab.view.width).put("height",tab.view.height), null)
            }
            "scroll" -> { tab.view.scrollBy(args.optInt("x", 0), args.optInt("y", 700)); complete(status(owner), null) }
            "back" -> { tab.view.goBack(); complete(status(owner), null) }
            "forward" -> { tab.view.goForward(); complete(status(owner), null) }
            "reload" -> { tab.ready = false; tab.view.reload(); awaitPage(tab, complete) { complete(status(owner), null) } }
            else -> error("未知浏览器操作")
        }
    }
}
