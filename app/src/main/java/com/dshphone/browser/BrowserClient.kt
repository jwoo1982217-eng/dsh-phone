package com.dshphone.browser

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.*
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CompletableFuture

/** Same-UID, non-exported Binder bridge. Browser lives outside the DSH login process. */
object BrowserClient {
    private val handler = Handler(Looper.getMainLooper())
    private var connecting: CompletableFuture<Messenger>? = null
    private val pending = linkedMapOf<String, CompletableFuture<JSONObject>>()
    private val replies = Messenger(object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(message: Message) {
            val id = message.data.getString("id") ?: return
            val future = pending.remove(id) ?: return
            val body = JSONObject(message.data.getString("json") ?: "{}")
            if (body.optBoolean("ok")) future.complete(body.getJSONObject("value"))
            else future.completeExceptionally(IllegalStateException(body.optString("error", "浏览器调用失败")))
        }
    })
    private fun connect(ctx: Context): CompletableFuture<Messenger> {
        connecting?.let { return it }
        val future = CompletableFuture<Messenger>(); connecting = future
        val bound = ctx.applicationContext.bindService(Intent(ctx, BrowserService::class.java), object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, binder: IBinder?) { future.complete(Messenger(binder)) }
            override fun onServiceDisconnected(name: ComponentName?) {
                connecting = null
                pending.values.forEach { it.completeExceptionally(IllegalStateException("浏览器进程断开，操作结果未知，请先读取页面")) }
                pending.clear()
            }
        }, Context.BIND_AUTO_CREATE)
        if (!bound) { connecting = null; future.completeExceptionally(IllegalStateException("浏览器服务无法启动")) }
        return future
    }
    fun call(ctx: Context, owner: String, method: String, args: JSONObject): CompletableFuture<JSONObject> {
        val future = CompletableFuture<JSONObject>()
        handler.post {
            connect(ctx).whenComplete { service, error -> handler.post {
                if (future.isCancelled) return@post
                if (error != null) { future.completeExceptionally(error); return@post }
                val id = UUID.randomUUID().toString(); pending[id] = future
                val message = Message.obtain(null, 1)
                message.replyTo = replies
                message.data = Bundle().apply {
                    putString("id", id)
                    putString("json", JSONObject().put("owner", owner).put("method", method).put("args", args).toString())
                }
                try { service.send(message) } catch (e: Exception) { pending.remove(id); future.completeExceptionally(e) }
                handler.postDelayed({ pending.remove(id)?.completeExceptionally(IllegalStateException("浏览器结果超时，勿重复提交动作")) }, 18_000)
            } }
        }
        return future
    }
}
