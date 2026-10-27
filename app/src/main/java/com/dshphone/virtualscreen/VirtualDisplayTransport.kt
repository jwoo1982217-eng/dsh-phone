package com.dshphone.virtualscreen

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Parcel
import org.json.JSONObject
import rikka.shizuku.Shizuku
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** No auto-grant and no retry of an action with an unknown outcome. */
object VirtualDisplayTransport {
    private val main = Handler(Looper.getMainLooper())
    private var binding: CompletableFuture<IBinder>? = null
    fun available(): Boolean = runCatching { Shizuku.pingBinder() && Shizuku.getVersion() >= 13 && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED }.getOrDefault(false)
    fun requestPermission() {
        check(runCatching { Shizuku.pingBinder() }.getOrDefault(false)) { "请先打开并启动 Shizuku" }
        if (!available()) Shizuku.requestPermission(9913)
    }
    @Synchronized private fun service(context: Context): CompletableFuture<IBinder> {
        binding?.let { if (!it.isCompletedExceptionally && (!it.isDone || it.getNow(null)?.pingBinder() == true)) return it }
        val next = CompletableFuture<IBinder>(); binding = next
        main.post {
            try {
                val args = Shizuku.UserServiceArgs(ComponentName(context,VirtualDisplayService::class.java))
                    .tag("dsh-virtual-screen").version(1).daemon(false).processNameSuffix("virtual-screen")
                Shizuku.bindUserService(args,object : ServiceConnection {
                    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
                        if (binder == null) next.completeExceptionally(IllegalStateException("虚拟屏通道未连接")) else next.complete(binder)
                    }
                    override fun onServiceDisconnected(name: ComponentName?) { synchronized(this@VirtualDisplayTransport) { if (binding === next) binding = null } }
                })
            } catch (error: Throwable) { next.completeExceptionally(error) }
        }
        return next
    }
    fun call(context: Context, args: JSONObject, canRun: () -> Boolean = { true }): JSONObject {
        check(available()) { "请在虚拟屏工作台由本人授权 Shizuku" }
        val pending = service(context.applicationContext)
        val binder = try { pending.get(6,TimeUnit.SECONDS) } catch (error: Throwable) {
            pending.completeExceptionally(error)
            synchronized(this) { if (binding === pending) binding = null }
            throw IllegalStateException("Shizuku 虚拟屏通道连接失败，请检查后再操作",error)
        }
        val request = Parcel.obtain(); val response = Parcel.obtain()
        try {
            check(canRun()) { "虚拟屏动作已取消，未提交" }
            request.writeInterfaceToken(VirtualDisplayService.DESCRIPTOR); request.writeString(args.toString())
            check(binder.transact(VirtualDisplayService.ACTION,request,response,0)) { "虚拟屏通道拒绝动作" }
            response.readException(); return JSONObject(response.readString().orEmpty())
        } finally { request.recycle(); response.recycle() }
    }
}
