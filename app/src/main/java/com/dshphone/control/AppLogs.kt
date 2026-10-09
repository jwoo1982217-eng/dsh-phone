package com.dshphone.control

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Parcel
import org.json.JSONObject
import rikka.shizuku.Shizuku
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

object AppLogs {
    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "dsh-app-logs").apply { isDaemon = true } }
    private var binding: CompletableFuture<IBinder>? = null
    fun status(): JSONObject {
        val running = runCatching { Shizuku.pingBinder() && Shizuku.getVersion() >= 13 }.getOrDefault(false)
        val granted = running && runCatching { Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED }.getOrDefault(false)
        return JSONObject().put("backend", "shizuku").put("running", running).put("permissionGranted", granted).put("available", granted)
            .put("hint", if (!running) "打开 Shizuku 并启动服务（Android 11+可用无线调试）" else if (!granted) "在服务→手机操作点“授权日志读取”，本人允许 Shizuku 授权" else "可按 App 读取最近日志；无日志输出会返回空内容")
    }
    fun requestPermission(ctx: Context) {
        check(status().getBoolean("running")) { "请先打开 Shizuku 并启动服务" }
        if (Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED) Shizuku.requestPermission(9912)
    }
    fun openSetup(ctx: Context) { ctx.startActivity((ctx.packageManager.getLaunchIntentForPackage("moe.shizuku.privileged.api") ?: Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://shizuku.rikka.app/guide/setup/"))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    @Synchronized private fun service(ctx: Context): CompletableFuture<IBinder> {
        binding?.let { if (!it.isCompletedExceptionally && (!it.isDone || it.getNow(null)?.pingBinder() == true)) return it }
        val future = CompletableFuture<IBinder>(); binding = future
        handler.post {
            try {
                val args = Shizuku.UserServiceArgs(ComponentName(ctx, AppLogService::class.java)).tag("dsh-app-logs").version(1).daemon(false).processNameSuffix("app-logs")
                Shizuku.bindUserService(args, object : ServiceConnection {
                    override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                        if (service == null) future.completeExceptionally(IllegalStateException("日志服务未连接")) else future.complete(service)
                    }
                    override fun onServiceDisconnected(name: ComponentName?) { synchronized(this@AppLogs) { if (binding === future) binding = null } }
                })
            } catch (error: Throwable) { future.completeExceptionally(error) }
        }
        return future
    }
    fun read(ctx: Context, packageName: String, lines: Int): CompletableFuture<JSONObject> = CompletableFuture.supplyAsync({
        require(packageName.matches(Regex("[a-zA-Z0-9_]+(?:\\.[a-zA-Z0-9_]+)+"))) { "App 包名无效" }
        require(lines in 1..1000) { "日志行数为 1–1000" }
        check(status().getBoolean("available")) { status().getString("hint") }
        val info = ctx.packageManager.getApplicationInfo(packageName, 0)
        check(ctx.packageManager.getPackagesForUid(info.uid)?.toSet() == setOf(packageName)) { "该 App 共用 UID，无法隔离其日志；请用 App 的日志导出功能" }
        val connection = service(ctx)
        val binder = try { connection.get(6, TimeUnit.SECONDS) } catch (error: Throwable) {
            connection.completeExceptionally(error)
            synchronized(this@AppLogs) { if (binding === connection) binding = null }
            throw IllegalStateException("日志服务连接失败；确认 Shizuku 正常后可重新读取", error)
        }
        val request = Parcel.obtain(); val reply = Parcel.obtain()
        try {
            request.writeInterfaceToken(AppLogService.DESCRIPTOR); request.writeInt(info.uid); request.writeInt(lines)
            check(binder.transact(AppLogService.READ, request, reply, 0)) { "日志服务没有接受请求" }
            reply.readException(); val text = reply.readString().orEmpty()
            JSONObject().put("status", "read").put("package", packageName).put("uid", info.uid).put("scope", "app_uid").put("text", text).put("empty", text.isBlank())
        } finally { request.recycle(); reply.recycle() }
    }, worker)
}
