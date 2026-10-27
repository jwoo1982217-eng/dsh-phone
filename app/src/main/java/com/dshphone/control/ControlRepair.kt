package com.dshphone.control

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Parcel
import android.os.SystemClock
import org.json.JSONObject
import rikka.shizuku.Shizuku
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Called by the native setup button only; not exposed as a model tool or bridge command. */
object ControlRepair {
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "dsh-control-repair").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())
    private var reconnecting: CompletableFuture<PhoneControlService>? = null
    private var lastAttempt = -60_000L
    fun enableAutomatic(ctx: Context) { ctx.getSharedPreferences("phone-control-setup", Context.MODE_PRIVATE).edit().putBoolean("auto_repair", true).apply() }
    fun automaticEnabled(ctx: Context) = ctx.getSharedPreferences("phone-control-setup", Context.MODE_PRIVATE).getBoolean("auto_repair", false)
    @Synchronized fun ensureConnected(ctx: Context): CompletableFuture<PhoneControlService> {
        ControlRuntime.service?.let { return CompletableFuture.completedFuture(it) }
        reconnecting?.let { if (!it.isDone) return it }
        check(automaticEnabled(ctx)) { "请在服务→手机操作点一次“开启并检查”；聊天权限保持不变" }
        val now = SystemClock.elapsedRealtime()
        check(now - lastAttempt >= 30_000) { "无障碍自动恢复尚未成功，请在服务→手机操作查看具体状态；本次动作未提交" }
        lastAttempt = now
        val result = CompletableFuture<PhoneControlService>(); reconnecting = result
        try {
            run(ctx, true).whenComplete { _, error -> main.post {
                if (error != null) result.completeExceptionally(IllegalStateException("无障碍自动恢复失败；请到服务→手机操作检查 Shizuku 和受限设置，本次动作未提交", error))
                else {
                    val deadline = SystemClock.elapsedRealtime() + 7000
                    val poll = object : Runnable {
                        override fun run() {
                            if (result.isDone) return
                            val service = ControlRuntime.service
                            if (service != null) result.complete(service)
                            else if (SystemClock.elapsedRealtime() >= deadline) result.completeExceptionally(IllegalStateException("系统尚未连接 DSH 无障碍；请到服务→手机操作查看，本次动作未提交"))
                            else main.postDelayed(this, 150)
                        }
                    }
                    poll.run()
                }
            } }
        } catch (error: Throwable) { result.completeExceptionally(error) }
        return result
    }
    @JvmOverloads fun run(ctx: Context, automatic: Boolean = false): CompletableFuture<JSONObject> {
        check(AppLogs.status().optBoolean("available")) { "需要已经授予的 Shizuku 权限" }
        val connected = CompletableFuture<IBinder>()
        val args = Shizuku.UserServiceArgs(ComponentName(ctx, ControlRepairService::class.java))
            // Closing one setup operation must not kill another in-flight reconnect.
            .tag("dsh-control-repair-" + java.util.UUID.randomUUID()).version(2).daemon(false).processNameSuffix("control-repair")
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
                if (binder == null) connected.completeExceptionally(IllegalStateException("恢复通道未连接")) else connected.complete(binder)
            }
            override fun onServiceDisconnected(name: ComponentName?) { connected.completeExceptionally(IllegalStateException("恢复通道已断开")) }
        }
        try { Shizuku.bindUserService(args, connection) } catch (error: Throwable) { connected.completeExceptionally(error) }
        return CompletableFuture.supplyAsync({
            try {
                val binder = connected.get(7, TimeUnit.SECONDS)
                val data = Parcel.obtain(); val reply = Parcel.obtain()
                try {
                    data.writeInterfaceToken(ControlRepairService.DESCRIPTOR)
                    check(binder.transact(if (automatic) ControlRepairService.RECONNECT else ControlRepairService.REPAIR, data, reply, 0)) { "恢复通道没有接受请求" }
                    reply.readException(); JSONObject(reply.readString().orEmpty())
                } finally { data.recycle(); reply.recycle() }
            } finally { main.post { runCatching { Shizuku.unbindUserService(args, connection, true) } } }
        }, worker)
    }
}
