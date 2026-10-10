package com.dshphone

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Message
import android.os.Looper
import java.util.concurrent.Executors
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebChromeClient
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.JsResult
import android.app.AlertDialog
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.widget.PopupMenu
import org.json.JSONObject

/**
 * WebView 壳：打开即是 dsh 的 Web 管理页（http://127.0.0.1:3080）——
 * 与电脑浏览器访问同一地址完全同构：会话列表、聊天、模型选择、工具轨迹，
 * 以及 codearts 插件注入的 Jet Hub 设置页（供应商登录/账号卡片/用量徽标）。
 * 供应商 OAuth 授权页（bigmodel.cn / trae.cn 等）也在本 WebView 内完成：
 * 授权回调打回 127.0.0.1，与 dsh 同机，天然可达。
 */
class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var statusDot: TextView
    private lateinit var statusText: TextView
    private lateinit var modeButton: TextView
    private lateinit var webView: WebView
    private lateinit var bootOverlay: LinearLayout
    private lateinit var bootLog: TextView
    private lateinit var content: FrameLayout
    private var loginOverlay: LinearLayout? = null
    private var loginWebView: WebView? = null
    private var showingLogs = false
    private var lastLoadedOk = false
    private val readinessWorker = Executors.newSingleThreadExecutor()
    private val jsonFileExport by lazy { JsonFileExport(this, readinessWorker) }
    private var probeRunning = false
    private var destroyed = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val fileRequestCode = 2401
    private val cardExportRequestCode = 2402
    private var pendingCardExport: ByteArray? = null
    private var cardExportBusy = false
    private var pendingQqInstall: String? = null
    private var remoteMode = false
    private var remotePageReady = false
    private var remoteLoadFailed = false
    private var pocketUrl: String? = null
    private val pocketConnection by lazy {
        PocketConnection(this, { url -> switchPage(true, url) }, {
            openLoginWindow("电脑连接").loadUrl("http://127.0.0.1:3080/phone-peer")
        })
    }
    private var recoveryDialog: AlertDialog? = null
    private var recoveryLabel: TextView? = null
    private var recoveryButtons = mutableListOf<TextView>()
    private var recoveryInfo = JSONObject()
    private var recoveryWasBusy = false
    private var recoveryRequestPending = false

    // Android 禁止主线程网络访问。旧代码在这里 Socket.connect，异常被吞掉，
    // 即使服务已经启动也永远返回 false，导致启动遮罩一直挡住完整管理页。
    private val refresher = object : Runnable {
        override fun run() {
            if (destroyed) return
            recoveryLabel?.text = DshService.recoveryMessage.ifEmpty { "请选择操作" }
            if (DshService.recoveryBusy) { recoveryWasBusy = true; recoveryRequestPending = false }
            if (recoveryWasBusy && !DshService.recoveryBusy) {
                recoveryWasBusy = false
                lastLoadedOk = false
                refreshRecoveryInfo()
            }
            recoveryButtons.forEach { it.isEnabled = !DshService.recoveryBusy && !recoveryRequestPending; it.alpha = if (it.isEnabled) 1f else .45f }
            if (!probeRunning) {
                probeRunning = true
                readinessWorker.execute {
                    val webReady = NodeRunner.webReady()
                    val gatewayReady = NodeRunner.portOpen(NodeRunner.GATEWAY_PORT)
                    handler.post {
                        if (!destroyed) updateReadiness(webReady, gatewayReady)
                        probeRunning = false
                    }
                }
            }
            if (bootOverlay.visibility == View.VISIBLE) {
                val text = DshService.snapshotLogs().takeLast(60).joinToString("\n")
                if (bootLog.text.toString() != text) bootLog.text = text
            }
            handler.postDelayed(this, 1500)
        }
    }

    private fun updateReadiness(webReady: Boolean, gatewayReady: Boolean) {
        val running = DshService.process?.isAlive == true
        val pageReady = if (remoteMode) remotePageReady else webReady
        statusDot.text = if (pageReady) "●" else "○"
        statusDot.setTextColor(if (pageReady) Color.rgb(22, 163, 74) else Color.GRAY)
        statusText.text = when {
            remoteMode && remoteLoadFailed -> "电脑加载失败 · 服务→设备连接可重新扫码"
            remoteMode && !remotePageReady -> "正在打开电脑 / 等待访问密码…"
            remoteMode -> "电脑模式"
            webReady && gatewayReady -> "运行中"
            webReady -> "界面已就绪 · 网关准备中"
            DshService.recoveryBusy -> "正在备份 / 恢复…"
            running -> "正在启动…"
            else -> "服务未运行"
        }
        modeButton.text = if (remoteMode) "手机" else "电脑"
        // 主界面依赖 Web 服务，网关慢启动不应挡住聊天和设置。
        if (remoteMode && pocketUrl != null) {
            if (!showingLogs) bootOverlay.visibility = View.GONE
        } else if (webReady && !lastLoadedOk) {
            lastLoadedOk = true
            webView.loadUrl(if (remoteMode) "http://127.0.0.1:3081/" else DshService.localStartUrl())
        } else if (!webReady && lastLoadedOk && !running) {
            lastLoadedOk = false
            if (!showingLogs) bootOverlay.visibility = View.VISIBLE
        }
    }

    /** 手机 VPN（TUN 全局/分应用）会把本 App 到 127.0.0.1 的流量也劫进隧道，
     *  导致端口探测永远失败、WebView 打不开本机管理页。绑定到非 VPN 的物理
     *  网络后，进程内所有 socket（含 WebView）直连；node 子进程不受影响。 */
    private fun bypassVpn() {
        runCatching {
            val cm = getSystemService(CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
            val physical = cm.allNetworks.firstOrNull { n ->
                val caps = cm.getNetworkCapabilities(n)
                caps != null && !caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)
                        && (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)
                        || caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR))
            } ?: return
            cm.bindProcessToNetwork(physical)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        if (android.os.Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false)
        bypassVpn()
        val pad = (12 * resources.displayMetrics.density).toInt()

        // ── 顶部状态栏 ──
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.rgb(248, 250, 252))
            setPadding(pad, pad / 2, pad, pad / 2)
            gravity = Gravity.CENTER_VERTICAL
        }
        statusDot = TextView(this).apply { text = "○"; textSize = 16f }
        statusText = TextView(this).apply {
            textSize = 12f
            setSingleLine(true)
            ellipsize = android.text.TextUtils.TruncateAt.END
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        fun mini(label: String, action: () -> Unit): TextView = TextView(this).apply {
            text = label; textSize = 14f
            minHeight = (44 * resources.displayMetrics.density).toInt()
            gravity = Gravity.CENTER
            setTextColor(Color.rgb(37, 99, 235))
            setPadding(pad, 0, 0, 0)
            setOnClickListener { action() }
        }
        bar.addView(statusDot)
        bar.addView(statusText)
        bar.addView(mini("账号", {
            openLoginWindow("DeepSeek 账号").loadUrl("http://127.0.0.1:3080/phone-account")
        }))
        bar.addView(mini("QQ", {
            openLoginWindow("QQ 机器人").loadUrl("http://127.0.0.1:3080/phone-bot")
        }))
        bar.addView(mini("技能", {
            openLoginWindow("技能中心").loadUrl("http://127.0.0.1:3080/phone-packs")
        }))
        modeButton = mini("电脑", {
            if (remoteMode) switchPage(false)
            else pocketConnection.openComputer()
        })
        bar.addView(modeButton)
        val serviceMenu = mini("服务", {})
        serviceMenu.setOnClickListener {
            PopupMenu(this, serviceMenu).apply {
                listOf("设备连接", "手机工具箱", "远程 Hermes", "返回手机本机", "内置浏览器", "手机操作", "备份与恢复", "文件访问权限", "工具环境", "复制网关地址", "保活", "查看日志", "启动服务", "停止服务").forEach { menu.add(it) }
                setOnMenuItemClickListener { item ->
                    when (item.title.toString()) {
                        "设备连接" -> pocketConnection.showConnections()
                        "手机工具箱" -> openLoginWindow("手机工具箱").loadUrl("http://127.0.0.1:3080/phone-tools")
                        "远程 Hermes" -> openLoginWindow("远程 Hermes").loadUrl("http://127.0.0.1:3080/hermes-remote")
                        "内置浏览器" -> startActivity(Intent(this@MainActivity, com.dshphone.browser.BrowserActivity::class.java))
                        "返回手机本机" -> switchPage(false)
                        "手机操作" -> startActivity(Intent(this@MainActivity, com.dshphone.control.ControlActivity::class.java))
                        "备份与恢复" -> showRecovery()
                        "文件访问权限" -> StorageAccess.show(this@MainActivity)
                        "工具环境" -> readinessWorker.execute {
                            val report = NodeRunner.toolEnvironmentReport(this@MainActivity)
                            handler.post {
                                if (!destroyed) AlertDialog.Builder(this@MainActivity)
                                    .setTitle("手机工具环境").setMessage(report)
                                    .setPositiveButton("知道了", null).show()
                            }
                        }
                        "复制网关地址" -> {
                            val cm = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
                            cm.setPrimaryClip(ClipData.newPlainText("dsh", "http://127.0.0.1:8326/v1"))
                            Toast.makeText(this@MainActivity, "已复制网关地址", Toast.LENGTH_SHORT).show()
                        }
                        "保活" -> startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:$packageName")))
                        "查看日志" -> {
                            showingLogs = !showingLogs
                            bootOverlay.visibility = if (showingLogs) View.VISIBLE else View.GONE
                        }
                        "启动服务" -> {
                            showingLogs = false
                            startForegroundService(Intent(this@MainActivity, DshService::class.java))
                        }
                        "停止服务" -> {
                            startService(Intent(this@MainActivity, DshService::class.java).setAction(DshService.ACTION_STOP))
                            lastLoadedOk = false; showingLogs = true
                            bootOverlay.visibility = View.VISIBLE
                        }
                    }
                    true
                }
                show()
            }
        }
        bar.addView(serviceMenu)

        // ── 主体：WebView + 启动遮罩 ──
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            // 桌面站点适配：按桌面视口宽度渲染后整体缩放到屏宽（可双指缩放），
            // 避免桌面布局在窄屏被压扁（侧栏只剩一条、按钮小到看不见）
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.builtInZoomControls = true
            settings.displayZoomControls = false
            settings.setSupportZoom(true)
            settings.allowFileAccess = false
            settings.allowContentAccess = true
            settings.setSupportMultipleWindows(true)
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>,
                    params: FileChooserParams): Boolean = chooseConfigFile(view, callback, params)
                override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
                    AlertDialog.Builder(this@MainActivity).setMessage(message)
                        .setPositiveButton("更新") { _, _ -> result.confirm() }
                        .setNegativeButton("取消") { _, _ -> result.cancel() }
                        .setOnCancelListener { result.cancel() }.show()
                    return true
                }
                override fun onCreateWindow(view: WebView, isDialog: Boolean,
                    isUserGesture: Boolean, resultMsg: Message): Boolean {
                    if (!isUserGesture) return false
                    val login = openLoginWindow(sourceUrl = view.url)
                    (resultMsg.obj as WebView.WebViewTransport).webView = login
                    resultMsg.sendToTarget()
                    return true
                }
            }
            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                    val uri = Uri.parse(url)
                    if (remoteMode && PocketConnection.sameOrigin(url, pocketUrl)) {
                        remotePageReady = false
                        remoteLoadFailed = false
                    } else if (uri.host == "127.0.0.1" && uri.port in listOf(NodeRunner.WEB_PORT, 3081)) {
                        pocketUrl = null
                        remoteMode = uri.port == 3081
                        remotePageReady = false
                        remoteLoadFailed = false
                        modeButton.text = if (remoteMode) "手机" else "电脑"
                    }
                }
                override fun onPageFinished(view: WebView, url: String) {
                    val uri = Uri.parse(url)
                    if (remoteMode && PocketConnection.sameOrigin(url, pocketUrl)) {
                        view.evaluateJavascript("Boolean(window.__DSH_BOOT__)") { marker ->
                            if (!destroyed && remoteMode && PocketConnection.sameOrigin(view.url, pocketUrl)) {
                                remotePageReady = marker == "true"
                            }
                        }
                        if (!showingLogs) bootOverlay.visibility = View.GONE
                    } else if (uri.host == "127.0.0.1" && uri.port in listOf(NodeRunner.WEB_PORT, 3081)) {
                        remoteMode = uri.port == 3081
                        installMobilePresentation(view)
                        if (remoteMode) view.evaluateJavascript("Boolean(window.__dshPeerRemote)") { marker ->
                            if (!destroyed && view.url?.startsWith("http://127.0.0.1:3081/") == true) {
                                remotePageReady = marker == "true"
                                remoteLoadFailed = !remotePageReady
                            }
                        }
                        if (lastLoadedOk && !showingLogs) bootOverlay.visibility = View.GONE
                    }
                }

                override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                    if (handlePhoneAction(view, req)) return true
                    // Existing provider login windows remain in place; ChatGPT uses the system browser.
                    return false
                }
                override fun onReceivedError(view: WebView, req: WebResourceRequest, e: android.webkit.WebResourceError) {
                    if (req.isForMainFrame && remoteMode && PocketConnection.sameOrigin(req.url.toString(), pocketUrl)) {
                        remoteLoadFailed = true
                        remotePageReady = false
                    } else if (req.isForMainFrame && req.url.host == "127.0.0.1") {
                        if (req.url.port == 3081) {
                            remoteLoadFailed = true
                            remotePageReady = false
                        } else {
                            lastLoadedOk = false
                            if (!showingLogs) bootOverlay.visibility = View.VISIBLE
                        }
                    }
                }
                override fun onReceivedHttpError(view: WebView, req: WebResourceRequest, response: android.webkit.WebResourceResponse) {
                    if (req.isForMainFrame && remoteMode && PocketConnection.sameOrigin(req.url.toString(), pocketUrl)) {
                        remoteLoadFailed = true
                        remotePageReady = false
                    }
                }
            }
        }
        bootOverlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            setPadding(pad, pad * 2, pad, pad)
        }
        bootOverlay.addView(TextView(this).apply {
            val appVersion = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: "未知"
            text = "正在启动 DSH 手机版 $appVersion（资源 ${NodeRunner.ASSET_VERSION}）…\n首次安装或升级需准备运行环境，请稍候；下次打开会更快。\n\n下方是启动日志："
            textSize = 14f
        })
        bootLog = TextView(this).apply {
            typeface = android.graphics.Typeface.MONOSPACE
            textSize = 9f
            setTextColor(Color.DKGRAY)
        }
        bootOverlay.addView(ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            addView(bootLog)
        })

        content = FrameLayout(this)
        content.addView(webView, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        content.addView(bootOverlay, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        // Reserve the visible IME as well as system bars. This resizes the same
        // WebView in both phone and computer mode, keeping the composer above it.
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                val sys = insets.getInsets(android.view.WindowInsets.Type.systemBars())
                val ime = insets.getInsets(android.view.WindowInsets.Type.ime())
                v.setPadding(sys.left, sys.top, sys.right, maxOf(sys.bottom, ime.bottom))
                android.view.WindowInsets.CONSUMED
            } else {
                v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                insets.consumeSystemWindowInsets()
            }
        }
        root.addView(bar, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(content, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        root.requestApplyInsets()

        startForegroundService(Intent(this, DshService::class.java))
        handler.post(refresher)
        handleChatGptReturn(intent)
    }

    private fun switchPage(computer: Boolean, pocket: String? = null) {
        // Finish the popup navigation callback before destroying its WebView.
        handler.post {
            if (destroyed) return@post
            closeLoginWindow()
            remoteMode = computer
            pocketUrl = if (computer) pocket else null
            remotePageReady = false
            remoteLoadFailed = false
            modeButton.text = if (computer) "手机" else "电脑"
            statusText.text = if (computer) "正在打开电脑…" else "手机模式"
            webView.stopLoading()
            lastLoadedOk = computer
            if (computer && !showingLogs) bootOverlay.visibility = View.GONE
            webView.loadUrl(if (computer) pocketUrl ?: "http://127.0.0.1:3081/" else DshService.localStartUrl())
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleChatGptReturn(intent)
    }

    private fun handleChatGptReturn(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme == "dsh-phone" && uri.host == "chatgpt" && uri.path == "/return") {
            closeLoginWindow()
            webView.evaluateJavascript("window.dispatchEvent(new Event('dsh-chatgpt-return'))", null)
        }
    }

    private fun installMobilePresentation(view: WebView) {
        val css = assets.open("dsh-phone.css").bufferedReader().use { it.readText() }
        val js = assets.open("dsh-phone.compat.js").bufferedReader().use { it.readText() } + "\n" +
            assets.open("dsh-phone.js").bufferedReader().use { it.readText() }
        view.evaluateJavascript("""
            (() => {
                let style = document.getElementById('dsh-phone-presentation');
                if (!style) {
                    style = document.createElement('style');
                    style.id = 'dsh-phone-presentation';
                    document.head.appendChild(style);
                }
                style.textContent = ${JSONObject.quote(css)};
            })();
            $js
        """.trimIndent(), null)
        installJsonFileExport(view)
    }

    private fun installJsonFileExport(view: WebView) {
        if (JsonFileExport.trusted(view.url)) view.evaluateJavascript(
            assets.open("dsh-phone.export.js").bufferedReader().use { it.readText() }, null)
    }

    /** 保留主界面，用独立 WebView 承接 Jet Hub 的 window.open 登录窗口。 */
    @SuppressLint("SetJavaScriptEnabled")
    private fun openLoginWindow(title: String = "账号登录", sourceUrl: String? = null): WebView {
        closeLoginWindow()
        val overlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
        }
        val close = TextView(this).apply {
            text = "‹ 返回 DSH · $title"
            textSize = 16f
            setTextColor(Color.rgb(37, 99, 235))
            setPadding(32, 24, 32, 24)
            setOnClickListener { closeLoginWindow() }
        }
        val login = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.allowFileAccess = false
            settings.allowContentAccess = true
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) { installJsonFileExport(view) }
                override fun shouldOverrideUrlLoading(view: WebView,
                    request: WebResourceRequest): Boolean {
                    // 新弹窗首个请求的 view.url 可能为空，使用创建它的本机页面作为来源。
                    if (ProviderLoginNavigation.shouldOpenWorkBuddyExternally(
                            sourceUrl, request.url.toString(), request.isForMainFrame)) {
                        openWorkBuddyBrowser(request.url)
                        return true
                    }
                    return handlePhoneAction(view, request)
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onCloseWindow(window: WebView) { closeLoginWindow() }
                override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>,
                    params: FileChooserParams): Boolean = chooseConfigFile(view, callback, params)
                override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
                    AlertDialog.Builder(this@MainActivity).setMessage(message)
                        .setPositiveButton("确认") { _, _ -> result.confirm() }
                        .setNegativeButton("取消") { _, _ -> result.cancel() }
                        .setOnCancelListener { result.cancel() }.show()
                    return true
                }
            }
        }
        overlay.addView(close)
        overlay.addView(login, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        loginOverlay = overlay
        loginWebView = login
        content.addView(overlay, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        return login
    }

    private fun openWorkBuddyBrowser(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
            loginWebView?.loadData("""
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <p style="font:18px sans-serif;padding:24px">请在系统浏览器完成 WorkBuddy 授权，然后点击上方「返回 DSH」查看账号和积分。</p>
            """.trimIndent(), "text/html", "UTF-8")
        } catch (_: android.content.ActivityNotFoundException) {
            Toast.makeText(this, "请安装手机浏览器后继续 WorkBuddy 授权", Toast.LENGTH_LONG).show()
        }
    }

    private fun handlePhoneAction(view: WebView, request: WebResourceRequest): Boolean {
        val uri = request.url
        val source = Uri.parse(view.url.orEmpty())
        val local = request.isForMainFrame && source.scheme == "http" && source.host == "127.0.0.1" && source.port == NodeRunner.WEB_PORT
        if (ProviderLoginNavigation.shouldOpenWorkBuddyExternally(
                view.url, uri.toString(), request.isForMainFrame)) {
            openWorkBuddyBrowser(uri)
            return true
        }
        if (uri.scheme == "dsh-phone" && uri.host == "files" && uri.path == "/save") {
            if (request.isForMainFrame && JsonFileExport.trusted(view.url)) jsonFileExport.request(view, uri.getQueryParameter("ticket").orEmpty())
            return true
        }
        if (uri.scheme == "dsh-phone" && uri.host == "cards" && uri.path == "/export") {
            if (request.isForMainFrame && source.scheme == "http" && source.host == "127.0.0.1" && source.port in listOf(NodeRunner.WEB_PORT, 3081)) exportAgentCards(source.port)
            return true
        }
        val officialChatGpt = uri.scheme == "https" && uri.userInfo == null && (uri.port == -1 || uri.port == 443) &&
            ((uri.host == "auth.openai.com" && uri.path == "/api/accounts/authorize") ||
                (uri.host == "chatgpt.com" && uri.path == "/settings/usage" && uri.fragment == null && uri.query == null))
        if (local && officialChatGpt) {
            try { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
            catch (_: android.content.ActivityNotFoundException) {
                Toast.makeText(this, "请安装浏览器后继续 ChatGPT 官方授权", Toast.LENGTH_LONG).show()
            }
            return true
        }
        if (uri.scheme != "dsh-phone") return false
        if (!local) return true
        if (uri.host == "browser") {
            val window = uri.getQueryParameter("window").orEmpty()
            if (window.matches(Regex("mcp_[a-f0-9]{40}"))) startActivity(Intent(this, com.dshphone.browser.BrowserActivity::class.java).putExtra("owner", window))
            return true
        }
        if (uri.host == "market" && uri.path == "/install") {
            val ticket = uri.getQueryParameter("ticket").orEmpty()
            if (ticket.matches(Regex("[a-f0-9]{64}"))) requestTrial(ticket)
            return true
        }
        if (uri.host == "market" && uri.path == "/recovery") { showRecovery(); return true }
        if (uri.host == "market" && uri.path == "/computer") {
            closeLoginWindow(); remoteMode = true; pocketUrl = null; remotePageReady = false; remoteLoadFailed = false
            webView.loadUrl("http://127.0.0.1:3081/controlled-market"); return true
        }
        if (uri.host == "storage" && uri.path == "/allow") {
            StorageAccess.show(this)
            return true
        }
        if (uri.host == "peer" && uri.path == "/remote") {
            switchPage(true)
            return true
        }
        if (uri.host == "service" && uri.path == "/restart") {
            startForegroundService(Intent(this, DshService::class.java).setAction(DshService.ACTION_RESTART))
            Toast.makeText(this, "正在重启 DSH，设置和账号会保留", Toast.LENGTH_SHORT).show()
            return true
        }
        if (uri.host != "qq") return true
        when (uri.path) {
            "/restart" -> TermuxQq.restart(this)
            "/allow" -> TermuxQq.showAuthorization(this)
            "/install" -> {
                val nonce = uri.getQueryParameter("nonce").orEmpty()
                if (nonce.matches(Regex("[a-f0-9]{64}"))) {
                    if (!TermuxQq.isInstalled(this)) TermuxQq.openEnvironment(this)
                    else if (checkSelfPermission(TermuxQq.PERMISSION) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        pendingQqInstall = nonce
                        requestPermissions(arrayOf(TermuxQq.PERMISSION), 2601)
                    } else TermuxQq.install(this, nonce)
                }
            }
        }
        return true
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == StorageAccess.REQUEST_CODE) {
            Toast.makeText(this, if (StorageAccess.granted(this)) "已授权，请重新打开工作区目录选择"
                else "未授权共享文件访问，仍可使用 DSH 内部工作区", Toast.LENGTH_LONG).show()
        }
        if (requestCode == 2601) {
            val nonce = pendingQqInstall; pendingQqInstall = null
            if (nonce != null && grantResults.firstOrNull() == android.content.pm.PackageManager.PERMISSION_GRANTED) TermuxQq.install(this, nonce)
            else Toast.makeText(this, "未授权手机运行环境。机器人配置已保留，可稍后重新授权。", Toast.LENGTH_LONG).show()
        }
    }

    private fun closeLoginWindow() {
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        loginOverlay?.let { content.removeView(it) }
        loginWebView?.destroy()
        loginOverlay = null
        loginWebView = null
    }

    private fun backupDescription(slot: String): String {
        val row = recoveryInfo.optJSONObject(slot) ?: return "尚无备份"
        val whenText = java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.CHINA).format(java.util.Date(row.getLong("createdAt")))
        return "$whenText · ${row.optString("appVersion")} · ${row.getLong("bytes") / 1024 / 1024} MB"
    }

    /** Native UI remains reachable even if an installed plugin prevents the Web server starting. */
    private fun showRecovery() {
        if (recoveryDialog?.isShowing == true) return
        val pad = (20 * resources.displayMetrics.density).toInt()
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad / 2, pad, pad) }
        body.addView(TextView(this).apply {
            text = "安装插件前先快速备份。恢复只替换本机插件、配置和运行程序，保留最新对话、账号、人设卡和配对信息。\n\n备份在本应用内部，卸载应用会删除。"
            textSize = 14f
        })
        recoveryLabel = TextView(this).apply { textSize = 14f; setPadding(0, pad, 0, pad); setTextColor(Color.rgb(37, 99, 235)) }
        body.addView(recoveryLabel)
        recoveryButtons.clear()
        fun button(label: String, action: String, slot: String = "") {
            val view = android.widget.Button(this).apply {
                text = label; isAllCaps = false; minHeight = (52 * resources.displayMetrics.density).toInt()
                setOnClickListener { requestRecovery(action, slot) }
            }
            recoveryButtons.add(view); body.addView(view, LinearLayout.LayoutParams(-1, -2))
        }
        button("快速备份", DshService.ACTION_BACKUP)
        button("恢复最近备份", DshService.ACTION_RESTORE, "latest")
        button("恢复较早备份", DshService.ACTION_RESTORE, "previous")
        button("撤销上次恢复", DshService.ACTION_RESTORE, "undo")
        val pluginsButton = android.widget.Button(this).apply { text = "禁用社区插件"; isAllCaps = false; setOnClickListener { showCommunityPlugins() } }
        recoveryButtons.add(pluginsButton); body.addView(pluginsButton, LinearLayout.LayoutParams(-1, -2))
        recoveryDialog = AlertDialog.Builder(this).setTitle("备份与恢复")
            .setView(ScrollView(this).apply { addView(body) }).setNegativeButton("关闭", null).create().apply {
                setOnDismissListener { recoveryDialog = null; recoveryLabel = null; recoveryButtons.clear() }
                show()
            }
        refreshRecoveryInfo()
    }

    private fun refreshRecoveryInfo() {
        readinessWorker.execute {
            val result = runCatching { RecoveryManager.status(this) }
            handler.post {
                if (destroyed || recoveryDialog?.isShowing != true) return@post
                result.onSuccess { recoveryInfo = it }
                if (recoveryButtons.size >= 4) {
                    recoveryButtons[1].text = "恢复最近备份\n${backupDescription("latest")}"
                    recoveryButtons[2].text = "恢复较早备份\n${backupDescription("previous")}"
                    recoveryButtons[3].text = "撤销上次恢复\n${backupDescription("undo")}"
                }
                result.onFailure { recoveryLabel?.text = "备份记录读取失败，当前数据未修改" }
            }
        }
    }

    private fun showCommunityPlugins() {
        readinessWorker.execute {
            val result = runCatching { RecoveryManager.communityPlugins(this) }
            handler.post {
                if (destroyed) return@post
                val names = result.getOrNull()
                if (names == null) { Toast.makeText(this, "插件配置无法读取，请使用恢复备份", Toast.LENGTH_LONG).show(); return@post }
                if (names.isEmpty()) { Toast.makeText(this, "没有额外安装的社区插件，内置功能受保护", Toast.LENGTH_LONG).show(); return@post }
                val selected = BooleanArray(names.size)
                AlertDialog.Builder(this).setTitle("选择要禁用的社区插件")
                    .setMultiChoiceItems(names.toTypedArray(), selected) { _, which, checked -> selected[which] = checked }
                    .setNegativeButton("取消", null).setPositiveButton("继续") { _, _ ->
                        val choices = names.filterIndexed { i, _ -> selected[i] }
                        if (choices.isNotEmpty()) requestRecovery(DshService.ACTION_DISABLE_PLUGINS, "", choices)
                    }.show()
            }
        }
    }

    private fun requestTrial(ticket: String) {
        if (DshService.recoveryBusy || recoveryRequestPending) return
        val cookie = CookieManager.getInstance().getCookie("http://127.0.0.1:3080").orEmpty()
        readinessWorker.execute {
            val count = LocalSessionStatus.activeCount(cookie)
            val preview = if (count == 0) runCatching { TrialInstaller.preview(ticket, cookie) } else null
            handler.post {
                if (destroyed) return@post
                if (count == null || count > 0) {
                    Toast.makeText(this, if (count == null) "无法确认任务状态，请刷新后重试" else "还有 $count 个 AI 任务运行，请结束后再试装", Toast.LENGTH_LONG).show()
                    return@post
                }
                val plan = preview?.getOrNull()
                if (plan == null) { Toast.makeText(this, preview?.exceptionOrNull()?.message ?: "试装确认已过期", Toast.LENGTH_LONG).show(); return@post }
                val label = plan.getString("name") + "@" + plan.getString("version") +
                    (if (plan.optString("commit") != "null" && plan.optString("commit").isNotBlank()) "\nGitHub 提交 ${plan.getString("commit").take(12)}" else "")
                fun cancel() { if (!destroyed) readinessWorker.execute { runCatching { TrialInstaller.cancel(ticket, cookie) } } }
                AlertDialog.Builder(this).setTitle("备份后试装到手机本机")
                    .setMessage("$label\n\n短暂停止本机服务，自动备份插件和配置，再安装已选的固定版本。安装失败会恢复环境；启动后发现不合适，可从「服务 → 备份与恢复」恢复最近备份。\n\n第三方插件可以访问 DSH 的文件和账号数据，备份不能隔离这些访问。")
                    .setNegativeButton("取消") { _, _ -> cancel() }.setOnCancelListener { cancel() }.setPositiveButton("备份并试装") { _, _ ->
                        showRecovery(); recoveryRequestPending = true; recoveryLabel?.text = "正在开始试装…"
                        startForegroundService(Intent(this, DshService::class.java).setAction(DshService.ACTION_INSTALL_PLUGIN)
                            .putExtra("cookie", cookie).putExtra("ticket", ticket))
                        handler.postDelayed({ recoveryRequestPending = false; if (!DshService.recoveryBusy) refreshRecoveryInfo() }, 3000)
                    }.show()
            }
        }
    }

    private fun requestRecovery(action: String, slot: String, plugins: List<String> = emptyList()) {
        if (DshService.recoveryBusy || recoveryRequestPending) return
        if (action == DshService.ACTION_RESTORE && recoveryInfo.optJSONObject(slot) == null) {
            Toast.makeText(this, "还没有这份备份，请先快速备份", Toast.LENGTH_LONG).show(); return
        }
        recoveryRequestPending = true
        val cookie = CookieManager.getInstance().getCookie("http://127.0.0.1:3080").orEmpty()
        readinessWorker.execute {
            val count = LocalSessionStatus.activeCount(cookie)
            handler.post {
                if (destroyed) return@post
                recoveryRequestPending = false
                if (count != null && count > 0) {
                    Toast.makeText(this, "还有 $count 个 AI 任务运行，请等结束后再操作", Toast.LENGTH_LONG).show(); return@post
                }
                val restoring = action == DshService.ACTION_RESTORE
                val disabling = action == DshService.ACTION_DISABLE_PLUGINS
                val message = (if (count == null) "当前无法读取任务状态。操作会停止手机本机服务。\n\n" else "操作会短暂停止并重新启动手机本机服务。\n\n") +
                    (if (disabling) "先备份，再禁用：${plugins.joinToString("、")}。对话和账号保留，可通过恢复备份撤销。" else if (restoring) "恢复 ${backupDescription(slot)} 的插件和配置，保留最新对话与账号；当前环境也会保存，可以撤销。" else "保存当前插件和配置，保留最近两份备份。备份完成后再安装插件。")
                AlertDialog.Builder(this).setTitle(if (disabling) "禁用社区插件" else if (restoring) "恢复备份" else "快速备份").setMessage(message)
                    .setNegativeButton("取消", null).setPositiveButton(if (disabling) "禁用" else if (restoring) "恢复" else "备份") { _, _ ->
                        recoveryRequestPending = true
                        recoveryLabel?.text = "正在开始…"
                        startForegroundService(Intent(this, DshService::class.java).setAction(action)
                            .putExtra("cookie", cookie).putExtra("slot", slot).putExtra("allowUnknown", count == null).putStringArrayListExtra("plugins", ArrayList(plugins)))
                        // A very small failed request may finish between refresh ticks.
                        handler.postDelayed({ recoveryRequestPending = false; if (!DshService.recoveryBusy) refreshRecoveryInfo() }, 3000)
                    }.show()
            }
        }
    }

    /** 系统文件选择器只提供用户选中的 content URI，无需申请存储访问权限。 */
    private fun chooseConfigFile(view: WebView, callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams): Boolean {
        val page = Uri.parse(view.url.orEmpty())
        if (page.host != "127.0.0.1" || page.port !in listOf(NodeRunner.WEB_PORT, 3081)) return false
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        return try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                // Android document providers often label .md as octet-stream or
                // an unknown MIME type. Accept files here; the importer checks
                // extension, UTF-8, size and ZIP structure after selection.
                type = if (params.acceptTypes.any { it.startsWith("image/") } &&
                    params.acceptTypes.all { it.isBlank() || it.startsWith("image/") }) "image/*" else "*/*"
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE)
            }
            startActivityForResult(intent, fileRequestCode)
            true
        } catch (_: Exception) {
            fileCallback = null
            callback.onReceiveValue(null)
            Toast.makeText(this, "无法打开文件选择器，请粘贴文件内容", Toast.LENGTH_SHORT).show()
            true
        }
    }

    private fun exportAgentCards(port: Int) {
        if (cardExportBusy) return
        cardExportBusy = true
        val cookie = CookieManager.getInstance().getCookie("http://127.0.0.1:$port").orEmpty()
        readinessWorker.execute {
            try {
                val connection = java.net.URL("http://127.0.0.1:$port/agent-cards/manage").openConnection() as java.net.HttpURLConnection
                val text = try {
                    connection.requestMethod = "POST"
                    connection.connectTimeout = 5000
                    connection.readTimeout = 10000
                    connection.doOutput = true
                    connection.setRequestProperty("Cookie", cookie)
                    connection.setRequestProperty("Content-Type", "application/json")
                    connection.setRequestProperty("Origin", "http://127.0.0.1:$port")
                    val body = JSONObject().put("type", "client-request").put("rpcId", java.util.UUID.randomUUID().toString()).put("method", "manage").put("payload", JSONObject().put("action", "export"))
                    connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                    check(connection.responseCode == 200)
                    connection.inputStream.use { input ->
                        val output = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(8192)
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            check(output.size() + count <= 524288)
                            output.write(buffer, 0, count)
                        }
                        val bytes = output.toByteArray()
                        JSONObject(String(bytes, Charsets.UTF_8)).getJSONObject("result").also { check(it.getBoolean("ok")) }.getJSONObject("value").toString(2)
                    }
                } finally { connection.disconnect() }
                handler.post {
                    if (!destroyed) {
                        pendingCardExport = text.toByteArray(Charsets.UTF_8)
                        try { startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "application/json"
                            putExtra(Intent.EXTRA_TITLE, "DSH-Agent人设卡.json")
                        }, cardExportRequestCode) }
                        catch (_: Exception) { pendingCardExport = null; cardExportBusy = false; Toast.makeText(this, "无法打开保存文件窗口", Toast.LENGTH_LONG).show() }
                    }
                }
            } catch (_: Exception) { handler.post { cardExportBusy = false; if (!destroyed) Toast.makeText(this, "人设导出未完成，请返回 DSH 刷新后重试", Toast.LENGTH_LONG).show() } }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (pocketConnection.onActivityResult(requestCode, resultCode, data)) return
        if (jsonFileExport.onActivityResult(requestCode, resultCode, data)) return
        if (requestCode == cardExportRequestCode) {
            cardExportBusy = false
            val bytes = pendingCardExport; pendingCardExport = null
            val uri = data?.data
            if (resultCode == RESULT_OK && uri?.scheme == "content" && bytes != null) readinessWorker.execute {
                val saved = runCatching { contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("No output stream") }.isSuccess
                handler.post { if (!destroyed) Toast.makeText(this, if (saved) "人设卡已保存" else "文件保存未完成，请重试", Toast.LENGTH_LONG).show() }
            }
            return
        }
        if (requestCode == fileRequestCode) {
            val result = if (resultCode == RESULT_OK) {
                val uris = data?.clipData?.let { clip -> (0 until clip.itemCount).map { clip.getItemAt(it).uri } }
                    ?: listOfNotNull(data?.data)
                uris.filter { it.scheme == "content" }.onEach { uri ->
                    if (data != null && data.flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION != 0) {
                        runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                    }
                }.toTypedArray().takeIf { it.isNotEmpty() }
            } else null
            fileCallback?.onReceiveValue(result)
            fileCallback = null
        }
    }

    override fun onResume() {
        super.onResume()
        bypassVpn()
    }

    override fun onDestroy() {
        destroyed = true
        jsonFileExport.destroy()
        handler.removeCallbacks(refresher)
        readinessWorker.shutdownNow()
        closeLoginWindow()
        webView.destroy()
        super.onDestroy()
    }

    override fun onBackPressed() {
        val login = loginWebView
        if (login != null) {
            if (login.canGoBack()) login.goBack() else closeLoginWindow()
        } else if (this::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else super.onBackPressed()
    }
}
