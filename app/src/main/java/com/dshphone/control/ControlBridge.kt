package com.dshphone.control

import android.content.Context
import android.net.LocalServerSocket
import android.os.Process
import org.json.JSONObject
import java.io.DataInputStream
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Private Android/Node IPC; no HTTP port, exported receiver or JS approval API. */
object ControlBridge {
    private var name: String? = null
    @Synchronized fun start(context: Context): String {
        name?.let { return it }
        ControlRuntime.attach(context)
        val address = "dsh-control-${UUID.randomUUID()}"
        val server = LocalServerSocket(address)
        val pool = Executors.newFixedThreadPool(2) { r -> Thread(r, "dsh-control-worker").apply { isDaemon = true } }
        Thread({
            while (true) {
                val socket = runCatching { server.accept() }.getOrNull() ?: break
                pool.execute {
                    socket.use {
                        if (it.peerCredentials.uid != Process.myUid()) return@execute
                        it.soTimeout = 20_000
                        var future: java.util.concurrent.CompletableFuture<JSONObject>? = null
                        val response = try {
                            val stream = DataInputStream(it.inputStream); val length = stream.readInt()
                            require(length in 1..65_536) { "请求太大" }
                            val bytes = ByteArray(length); stream.readFully(bytes)
                            future = ControlRuntime.call(context, JSONObject(String(bytes, Charsets.UTF_8)))
                            JSONObject().put("ok", true).put("value", future!!.get(20, TimeUnit.SECONDS))
                        } catch (error: Throwable) {
                            future?.cancel(false)
                            JSONObject().put("ok", false).put("error", error.cause?.message ?: error.message ?: "手机操作失败")
                        }
                        runCatching { it.outputStream.write(response.toString().toByteArray(Charsets.UTF_8)) }
                    }
                }
            }
        }, "dsh-control-listener").apply { isDaemon = true; start() }
        name = address; return address
    }
}
