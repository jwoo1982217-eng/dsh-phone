package com.dshphone

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.CookieManager
import android.widget.Toast
import org.json.JSONObject
import android.util.JsonReader
import android.util.JsonToken
import java.io.StringReader
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URI
import java.net.URL
import java.nio.charset.CodingErrorAction
import java.nio.ByteBuffer
import java.util.Base64
import java.util.UUID
import java.util.concurrent.Executors

/** Transient capability. Deliberately has no data-class toString or persistence method. */
internal class PeerLink private constructor(val code: String, val relayHost: String) {
    override fun toString() = "PeerLink([private])"
    companion object {
        fun parse(raw: String): PeerLink? = runCatching {
            require(raw.length in 1..2048 && raw.none { it <= ' ' || it == '\\' })
            val uri = URI(raw)
            require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawPath == "/connect")
            val bridge = uri.scheme == "https"
            require(bridge || uri.scheme == "dsh-phone" && uri.rawAuthority == "peer" && uri.port == -1)
            val code = uri.rawFragment ?: error("Missing capability")
            require(code.startsWith("dsh-peer:1:"))
            val encoded = code.substring(11)
            require(encoded.matches(Regex("[A-Za-z0-9_-]+")))
            val bytes = Base64.getUrlDecoder().decode(encoded)
            require(Base64.getUrlEncoder().withoutPadding().encodeToString(bytes) == encoded)
            val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
            val pair = mutableMapOf<String, String>()
            JsonReader(StringReader(text)).use { reader ->
                reader.isLenient = false
                reader.beginObject()
                while (reader.hasNext()) {
                    val key = reader.nextName()
                    require(!pair.containsKey(key) && key in setOf("version", "relay", "room", "secret"))
                    if (key == "version") { require(reader.peek() == JsonToken.NUMBER && reader.nextDouble() == 1.0); pair[key] = "1" }
                    else { require(reader.peek() == JsonToken.STRING); pair[key] = reader.nextString() }
                }
                reader.endObject()
                require(reader.peek() == JsonToken.END_DOCUMENT && pair.size == 4)
            }
            require(pair["room"]?.matches(Regex("[a-f0-9]{32}")) == true)
            require(pair["secret"]?.matches(Regex("[a-f0-9]{64}")) == true)
            val relay = URI(pair.getValue("relay"))
            require(relay.host != null && relay.rawUserInfo == null && relay.rawQuery == null && relay.rawFragment == null)
            require(relay.port == -1 || relay.port in 1..65535)
            require(relay.scheme == "wss" || relay.scheme == "ws" && relay.host in listOf("localhost", "127.0.0.1", "[::1]"))
            if (bridge) {
                require(uri.host != null && uri.port.let { it == -1 || it in 1..65535 })
                require(relay.scheme == "wss" && relay.rawPath == "/relay")
                fun port(u: URI) = if (u.port == -1) 443 else u.port
                require(uri.host.equals(relay.host, true) && port(uri) == port(relay))
            }
            PeerLink(code, relay.host)
        }.getOrNull()
    }
}

internal data class PeerStatus(val paired: Boolean, val connected: Boolean)
internal interface PeerHost {
    fun confirm(host: String, answer: (Boolean) -> Unit)
    fun background(job: () -> Unit)
    fun ui(job: () -> Unit)
    fun start()
    fun ready(): Boolean
    fun now(): Long
    fun pause(ms: Long)
    fun manage(action: String, code: String?): PeerStatus
    fun selectPeer()
    fun navigate(admitted: () -> Boolean)
    fun viewingPeer(): Boolean
    fun message(text: String)
    fun choices()
}

/** UI-thread admission and lifecycle; worker only receives a transient, confirmed capability. */
internal class PeerController(private val host: PeerHost) {
    @Volatile private var epoch = 0L
    @Volatile private var closed = false
    @Volatile private var busy = false
    private var lastRecovery = -15_000L
    private fun current(id: Long) = !closed && epoch == id
    fun accept(raw: String): Boolean {
        if (closed) return false
        busy = false
        val id = ++epoch
        val link = PeerLink.parse(raw)
        if (link == null) { host.message("连接链接无效，请从电脑重新复制完整链接"); return false }
        var answered = false
        host.confirm(link.relayHost) { accepted ->
            if (!answered) {
                answered = true
                if (accepted && current(id)) begin(id, link, true)
            }
        }
        return true
    }
    fun open() { if (!closed && !busy) begin(++epoch, null, true) }
    fun recover() {
        if (closed || busy || !host.viewingPeer() || host.now() - lastRecovery < 15_000) return
        lastRecovery = host.now()
        begin(epoch, null, false)
    }
    private fun begin(id: Long, link: PeerLink?, navigate: Boolean) {
        busy = true
        if (navigate) host.message("正在连接电脑，请稍候…")
        host.background {
            var unpaired = false
            var admitted = false
            val result = runCatching {
                if (!current(id)) return@runCatching false
                host.start()
                val deadline = host.now() + 90_000
                while (current(id) && !host.ready()) {
                    check(host.now() < deadline) { "not-ready" }
                    host.pause(500)
                }
                if (!current(id)) return@runCatching false
                var status = if (link != null) host.manage("pair", link.code) else host.manage("status", null)
                if (!current(id)) return@runCatching false
                if (!status.paired) { unpaired = true; return@runCatching false }
                admitted = true
                if (link == null && !status.connected) status = host.manage("reconnect", null)
                if (navigate) {
                    val connectedDeadline = host.now() + 15_000
                    while (current(id) && !status.connected && host.now() < connectedDeadline) {
                        host.pause(500)
                        if (current(id)) status = host.manage("status", null)
                    }
                }
                status.connected
            }
            host.ui {
                if (!current(id)) return@ui
                busy = false
                if (admitted && navigate) host.selectPeer()
                if (result.getOrDefault(false)) {
                    if (navigate) host.navigate { current(id) }
                } else if (unpaired && navigate) host.choices()
                else if (navigate) host.message(if (admitted) "已记住电脑连接。电脑离线或连接中，请保持两端服务运行，稍后点击电脑重试" else "电脑连接尚未就绪，请检查两端服务后点击电脑重试")
            }
        }
    }
    fun leave() { ++epoch; busy = false }
    fun pending() = busy
    fun close() { closed = true; ++epoch }
}

/** Only the selected connection type belongs in ordinary Android preferences. */
internal class ComputerSelection(context: Context) {
    private val prefs = context.getSharedPreferences("computer-connection", Context.MODE_PRIVATE)
    fun peer() { prefs.edit().putString("kind", "peer").apply() }
    fun pocket() { prefs.edit().putString("kind", "pocket").apply() }
    fun isPeer() = prefs.getString("kind", null) == "peer"
}

/** Authenticated loopback only, matching native recovery's cold-cookie bootstrap. */
internal class PeerLocalClient(
    private val origin: String = "http://127.0.0.1:3080",
    private val launch: () -> String? = { DshService.browserLaunchUrl },
    private val cookie: () -> String = { CookieManager.getInstance().getCookie("http://127.0.0.1:3080").orEmpty() },
) {
    fun manage(action: String, code: String?): PeerStatus {
        var session = cookie()
        fun request(): JSONObject? {
            val c = URL("$origin/phone-peer/manage").openConnection(Proxy.NO_PROXY) as HttpURLConnection
            try {
                c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 2000; c.readTimeout = 5000; c.instanceFollowRedirects = false
                c.setRequestProperty("Origin", origin); c.setRequestProperty("Cookie", session); c.setRequestProperty("Content-Type", "application/json")
                val payload = JSONObject().put("action", action)
                if (code != null) payload.put("code", code)
                val bytes = JSONObject().put("type", "client-request").put("rpcId", UUID.randomUUID().toString())
                    .put("method", "manage").put("payload", payload).toString().toByteArray()
                c.setFixedLengthStreamingMode(bytes.size); c.outputStream.use { it.write(bytes) }
                if (c.responseCode == 401) return null
                check(c.responseCode == 200)
                val body = c.inputStream.use { input ->
                    val out = ByteArrayOutputStream(); val buffer = ByteArray(4096)
                    while (out.size() <= 64 * 1024) { val count = input.read(buffer); if (count < 0) break; out.write(buffer, 0, count) }
                    out.toByteArray()
                }
                check(body.size <= 64 * 1024)
                val result = JSONObject(String(body, Charsets.UTF_8)).getJSONObject("result")
                check(result.optBoolean("ok"))
                return result.getJSONObject("value")
            } finally { c.disconnect() }
        }
        var value = request()
        if (value == null) {
            val start = URI(launch() ?: error("Local authentication pending"))
            val base = URI(origin)
            check(start.scheme == base.scheme && start.host == base.host && start.port == base.port && start.rawUserInfo == null && start.rawPath == "/")
            val c = start.toURL().openConnection(Proxy.NO_PROXY) as HttpURLConnection
            try {
                c.connectTimeout = 2000; c.readTimeout = 3000; c.instanceFollowRedirects = false
                check(c.responseCode == 303)
                session = c.headerFields.filterKeys { it?.equals("Set-Cookie", true) == true }.values.flatten().joinToString("; ") { it.substringBefore(';') }
                check(session.isNotEmpty())
            } finally { c.disconnect() }
            value = request() ?: error("Local authentication pending")
        }
        return PeerStatus(value.optBoolean("paired"), value.optBoolean("connected"))
    }
}

/** Small native adapter: activity lifecycle and networking stay outside the admission state machine. */
class PeerConnection(
    private val activity: Activity,
    private val open: (() -> Boolean) -> Unit,
    private val viewing: () -> Boolean,
    private val refreshNetwork: () -> Unit,
    private val connections: () -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val selection = ComputerSelection(activity)
    private val client = PeerLocalClient()
    private var closed = false
    private var dialog: AlertDialog? = null
    private val controller = PeerController(object : PeerHost {
        override fun confirm(host: String, answer: (Boolean) -> Unit) {
            dialog?.dismiss()
            dialog = AlertDialog.Builder(activity).setTitle("连接这台电脑？")
                .setMessage("此链接允许访问电脑 DSH 的聊天、文件和已配置工具。请只连接你信任的电脑。\n加密中继：$host")
                .setPositiveButton("连接") { _, _ -> answer(true) }.setNegativeButton("取消") { _, _ -> answer(false) }.show()
            dialog?.setOnDismissListener { dialog = null }
        }
        override fun background(job: () -> Unit) { worker.execute(job) }
        override fun ui(job: () -> Unit) { handler.post { if (!closed) job() } }
        override fun start() { activity.startForegroundService(Intent(activity, DshService::class.java).setAction(DshService.ACTION_START)) }
        override fun ready() = NodeRunner.webReady()
        override fun now() = SystemClock.elapsedRealtime()
        override fun pause(ms: Long) { Thread.sleep(ms) }
        override fun manage(action: String, code: String?) = client.manage(action, code)
        override fun selectPeer() { selection.peer() }
        override fun navigate(admitted: () -> Boolean) = open(admitted)
        override fun viewingPeer() = viewing()
        override fun message(text: String) { if (!closed) Toast.makeText(activity, text, Toast.LENGTH_LONG).show() }
        override fun choices() = connections()
    })
    private val network = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val recovery = Runnable { if (!closed && (viewing() || controller.pending())) { refreshNetwork(); controller.recover() } }
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = changed()
        override fun onLost(network: Network) = changed()
        private fun changed() { handler.removeCallbacks(recovery); handler.postDelayed(recovery, 500) }
    }
    init {
        runCatching { network.registerNetworkCallback(NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), callback) }
    }
    fun consume(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val uri = intent.data ?: return
        if (!(uri.scheme == "dsh-phone" && uri.host == "peer" || uri.scheme == "https" && uri.path == "/connect")) return
        val raw = uri.toString()
        intent.data = null // Do not save/replay capabilities through activity recreation or later intents.
        controller.accept(raw)
    }
    fun openComputer() = controller.open()
    fun resume() = controller.recover()
    fun leave() = controller.leave()
    fun close() {
        closed = true; controller.close(); dialog?.dismiss(); dialog = null
        handler.removeCallbacksAndMessages(null)
        runCatching { network.unregisterNetworkCallback(callback) }
        worker.shutdownNow()
    }
}
