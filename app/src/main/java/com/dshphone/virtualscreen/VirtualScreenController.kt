package com.dshphone.virtualscreen

import android.content.Context
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.view.Surface
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Single owned display. Its alias never falls back to display 0, including after removal. */
object VirtualScreenController {
    private data class Screen(val display: VirtualDisplay,val reader: ImageReader,val thread: HandlerThread,var width: Int,var height: Int) {
        val id get() = display.display.displayId
    }
    private val lock = Any()
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r,"dsh-virtual-ops").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())
    private var screen: Screen? = null
    private var viewer: Surface? = null
    private var generation = 0L
    private var touched = 0L
    private var snapshot: VirtualScreenPolicy.Snapshot? = null
    private var snapshotUi: String? = null
    private var app: Context? = null
    private val idle = object : Runnable {
        override fun run() {
            synchronized(lock) {
                if (screen == null) return
                if (SystemClock.elapsedRealtime() - touched >= 600_000) release() else main.postDelayed(this,30_000)
            }
        }
    }
    fun status(): JSONObject = synchronized(lock) {
        val value = screen?.also { geometry(it) }
        JSONObject().put("status",if (value == null) "idle" else "active").put("screenId","virtual-1")
            .put("displayId",value?.id ?: JSONObject.NULL).put("width",value?.width ?: 0).put("height",value?.height ?: 0)
            .put("generation",generation).put("shizukuReady",VirtualDisplayTransport.available()).put("presenting",viewer?.isValid == true)
    }
    fun dimensions(): Pair<Int,Int>? = synchronized(lock) { screen?.let { geometry(it); it.width to it.height } }
    fun attach(surface: Surface) = synchronized(lock) {
        check(surface.isValid) { "虚拟屏查看器尚未就绪" }; viewer = surface
        screen?.display?.surface = surface; touched = SystemClock.elapsedRealtime()
    }
    fun detach(surface: Surface? = null) = synchronized(lock) {
        if (surface != null && viewer !== surface) return@synchronized
        viewer = null; screen?.let { it.display.surface = it.reader.surface }
    }
    fun dispatch(context: Context,owner: String,args: JSONObject,canRun: () -> Boolean = { true }): CompletableFuture<JSONObject> = dispatchCommon(context,owner,args,false,canRun)
    fun dispatchViewer(context: Context,args: JSONObject): CompletableFuture<JSONObject> = dispatchCommon(context,"native-viewer",args,true) { true }
    private fun dispatchCommon(context: Context,owner: String,args: JSONObject,nativeGesture: Boolean,canRun: () -> Boolean): CompletableFuture<JSONObject> = CompletableFuture.supplyAsync({
        check(canRun()) { "虚拟屏动作已取消，未提交" }
        require(args.optString("screenId","virtual-1") == "virtual-1") { "只允许本应用拥有的 virtual-1；不会回退真实屏" }
        if (args.optString("action") !in setOf("status","destroy")) check(!(context.getSystemService(Context.KEYGUARD_SERVICE) as android.app.KeyguardManager).isKeyguardLocked) { "请先由本人解锁手机" }
        app = context.applicationContext
        when (val action = args.getString("action")) {
            "status" -> status()
            "create" -> create(context,args)
            "destroy" -> synchronized(lock) { release(); status() }
            "screenshot", "read" -> screenshot(owner)
            "launch", "tap", "swipe", "back" -> perform(context,owner,args,action,nativeGesture,canRun)
            else -> error("不支持的虚拟屏动作")
        }
    },worker)
    private fun create(context: Context,args: JSONObject): JSONObject = synchronized(lock) {
        if (screen != null) return status()
        check(VirtualDisplayTransport.available()) { "请先在虚拟屏工作台由本人授权 Shizuku" }
        val width = args.optInt("width",480); val height = args.optInt("height",800)
        require(width in 240..1920 && height in 240..1920) { "虚拟屏宽高范围为240–1920像素" }
        val dpi = args.optInt("densityDpi",240); require(dpi in 120..640)
        val thread = HandlerThread("dsh-virtual-pixels").also { it.start() }
        val reader = ImageReader.newInstance(width,height,PixelFormat.RGBA_8888,2)
        var created: VirtualDisplay? = null
        try {
            reader.setOnImageAvailableListener({ source -> runCatching { source.acquireLatestImage()?.close() } },Handler(thread.looper))
            // MIT official source parity: OWN_CONTENT_ONLY forbids mirroring the real display;
            // DESTROY_CONTENT_ON_REMOVAL prevents closing a virtual task from moving it to display 0.
            val flags = 1 or (1 shl 3) or (1 shl 6) or (1 shl 7) or (1 shl 8)
            val display = (context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).createVirtualDisplay("DSH virtual-1",width,height,dpi,reader.surface,flags)
                ?: error("系统没有创建虚拟屏")
            created = display
            check(display.display.displayId > 0) { "系统返回了不安全的屏幕编号" }
            screen = Screen(display,reader,thread,width,height); generation++; snapshot = null; snapshotUi = null
            viewer?.takeIf { it.isValid }?.let { display.surface = it }
            touched = SystemClock.elapsedRealtime(); main.removeCallbacks(idle); main.postDelayed(idle,30_000); status()
        } catch (error: Throwable) { runCatching { created?.release() }; reader.close(); thread.quitSafely(); throw error }
    }
    private fun release() {
        snapshot = null; snapshotUi = null; generation++; main.removeCallbacks(idle)
        val old = screen; screen = null
        if (old != null) { runCatching { old.display.release() }; old.reader.close(); old.thread.quitSafely() }
    }
    private fun current(): Screen {
        val value = screen ?: error("虚拟屏尚未创建；不会改为操作真实屏")
        VirtualScreenPolicy.requireOwned("virtual-1",value.id)
        check((app!!.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).getDisplay(value.id) != null) { "虚拟屏已被系统移除" }
        geometry(value)
        return value
    }
    private fun geometry(value: Screen) {
        val metrics = android.util.DisplayMetrics(); value.display.display.getRealMetrics(metrics)
        if (metrics.widthPixels > 0 && metrics.heightPixels > 0 && (metrics.widthPixels != value.width || metrics.heightPixels != value.height)) {
            value.width = metrics.widthPixels; value.height = metrics.heightPixels; generation++; snapshot = null; snapshotUi = null
        }
    }
    private fun screenshot(owner: String): JSONObject {
        check(android.os.Build.VERSION.SDK_INT >= 30) { "独立屏幕截图需要Android11以上及已由本人启用的无障碍服务；不会读取真实屏" }
        val before: Long; val width: Int; val height: Int
        val value = synchronized(lock) { current().also { before = generation; width = it.width; height = it.height; touched = SystemClock.elapsedRealtime() } }
        val pending = CompletableFuture<JSONObject>()
        main.post {
            try {
                val beforeUi = VirtualScreenGuard.check(value.id,owner)
                val service = com.dshphone.control.ControlRuntime.service ?: error("请先由本人启用手机操作无障碍服务")
                service.takeScreenshot(value.id,service.mainExecutor,object : android.accessibilityservice.AccessibilityService.TakeScreenshotCallback {
                    override fun onSuccess(result: android.accessibilityservice.AccessibilityService.ScreenshotResult) {
                        try {
                            if (pending.isDone) return
                            check(VirtualScreenGuard.check(value.id,owner) == beforeUi) { "虚拟屏界面在截图期间变化，请重读" }
                            synchronized(lock) { check(current() === value && generation == before) { "截图期间屏幕尺寸或内容目标已变化，请重读" } }
                            check(result.hardwareBuffer.width == width && result.hardwareBuffer.height == height) { "独立屏幕截图尺寸与当前屏幕不符，请重读；不会借用真实屏" }
                            pending.complete(com.dshphone.control.PhoneScreenshot.encode(result,android.graphics.Rect(0,0,width,height)).put("uiFingerprint",beforeUi))
                        } catch (error: Throwable) { pending.completeExceptionally(error) }
                        finally { result.hardwareBuffer.close() }
                    }
                    override fun onFailure(errorCode: Int) { pending.completeExceptionally(IllegalStateException("系统拒绝独立屏幕截图（$errorCode）；请查看虚拟屏工作台，不会回退真实屏")) }
                })
            } catch (error: Throwable) { pending.completeExceptionally(error) }
        }
        try {
            val image = pending.get(4,TimeUnit.SECONDS)
            val nonce = UUID.randomUUID().toString()
            synchronized(lock) {
                check(current() === value && generation == before) { "截图之后虚拟屏已变化，请重读" }
                snapshot = VirtualScreenPolicy.Snapshot(owner,nonce,value.id,width,height,generation,SystemClock.elapsedRealtime())
                snapshotUi = image.getString("uiFingerprint"); image.remove("uiFingerprint")
            }
            return image.put("status","screenshot").put("screenId","virtual-1").put("displayId",value.id).put("scope","virtual")
                .put("snapshotId",nonce).put("width",width).put("height",height)
                .put("hint","只操作virtual-1；将图片坐标乘screenWidth/imageWidth、screenHeight/imageHeight得到该虚拟屏原像素坐标")
        } finally { pending.cancel(false) }
    }
    private fun perform(context: Context,owner: String,args: JSONObject,action: String,nativeGesture: Boolean,canRun: () -> Boolean): JSONObject {
        val request = JSONObject(args.toString())
        val proof = if (!nativeGesture && action != "launch") guard(owner,synchronized(lock) { current().id }) else null
        synchronized(lock) {
            val value = current()
            if (!nativeGesture && action != "launch") {
                check(snapshot?.matches(owner,args.optString("snapshotId"),value.id,generation,SystemClock.elapsedRealtime()) == true && snapshotUi == proof) { "虚拟屏界面或快照已变化，请重新读取该屏截图" }
            }
            snapshot = null; snapshotUi = null; generation++; touched = SystemClock.elapsedRealtime()
            request.put("screenId","virtual-1").put("displayId",value.id).put("width",value.width).put("height",value.height)
        }
        return VirtualDisplayTransport.call(context,request) { canRun() && (proof == null || guard(owner,request.getInt("displayId")) == proof) }
    }
    private fun guard(owner: String,id: Int): String {
        val result = CompletableFuture<String>()
        main.post { try { result.complete(VirtualScreenGuard.check(id,owner)) } catch(error: Throwable) { result.completeExceptionally(error) } }
        return result.get(2,TimeUnit.SECONDS)
    }
}
