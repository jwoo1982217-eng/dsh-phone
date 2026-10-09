package com.dshphone.control

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.view.Gravity
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.widget.TextView
import org.json.JSONObject
import java.util.UUID

class PhoneControlService : AccessibilityService() {
    private data class Snapshot(val id: String, val hash: String, val packageName: String, val window: Int, val version: Long, val at: Long, val epoch: Long)
    private var snapshot: Snapshot? = null
    private var version = 0L
    private var stopView: TextView? = null
    private var gestureBusy = false
    override fun onServiceConnected() { ControlRuntime.attach(this); ControlRuntime.service = this }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.packageName?.toString() != packageName && event?.eventType in listOf(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED, AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED)) version++
    }
    override fun onInterrupt() { ControlRuntime.stop("无障碍服务中断") }
    override fun onDestroy() {
        ControlRuntime.stop("无障碍服务已关闭")
        if (ControlRuntime.service === this) ControlRuntime.service = null
        super.onDestroy()
    }
    fun clear() { snapshot = null; hideStop() }
    private fun screen(owner: String, epoch: Long): ControlScreen {
        check(!(getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked) { "请先由本人解锁手机" }
        val root = rootInActiveWindow ?: error("当前界面无法读取，请打开已授权 App")
        try { val target = root.packageName?.toString().orEmpty(); check(target.isNotBlank()) { "界面没有可验证的 App 身份" }; ControlRuntime.lease.check(owner, target, epoch); return ControlScreen(root) }
        catch (error: Throwable) { root.recycle(); throw error }
    }
    private fun checkedScreen(owner: String, epoch: Long, args: JSONObject): ControlScreen {
        val prior = snapshot ?: error("请先读取当前界面")
        check(args.optString("snapshotId") == prior.id && prior.epoch == epoch && SystemClock.elapsedRealtime() - prior.at <= 30_000) { "界面快照已过期，请重新读取" }
        val tree = screen(owner, epoch)
        try {
            check(tree.packageName == prior.packageName && tree.windowId == prior.window && version == prior.version && tree.fingerprint() == prior.hash) { "界面已经变化，操作未执行，请重新读取" }
            return tree
        } catch (error: Throwable) { tree.close(); throw error }
    }
    fun execute(owner: String, epoch: Long, args: JSONObject, confirmed: Boolean, done: (JSONObject) -> Unit) {
        val grant = ControlRuntime.lease.check(owner, expectedEpoch = epoch)
        val action = args.getString("action")
        check(grant.policyMode == null || grant.policyMode == "danger-full-access" || action in listOf("read", "screenshot")) { "当前会话仅允许查看手机；操作其他 App 请使用聊天已有的完全权限模式。工作区修改请用受限文件工具" }
        check(!(getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked) { "请先由本人解锁手机" }
        check(!gestureBusy) { "上一手势尚未结束，请等待结果" }
        if (action == "launch") {
            val target = args.getString("package")
            ControlRuntime.lease.check(owner, target, epoch)
            val intent = packageManager.getLaunchIntentForPackage(target) ?: error("该 App 没有可打开的入口")
            snapshot = null
            startActivity(intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
            done(JSONObject().put("status", "launched").put("package", target).put("hint", "请重新读取界面确认打开结果")); return
        }
        if (action == "read") {
            screen(owner, epoch).use { tree ->
                val id = UUID.randomUUID().toString()
                snapshot = Snapshot(id, tree.fingerprint(), tree.packageName, tree.windowId, version, SystemClock.elapsedRealtime(), epoch)
                done(tree.json().put("status", "observed").put("snapshotId", id))
            }; return
        }
        if (action == "screenshot") {
            check(android.os.Build.VERSION.SDK_INT >= 30) { "截图需要 Android 11 及以上；可继续用 read 读取界面" }
            screen(owner, epoch).use { tree ->
                check(tree.nodes.values.none { it.isPassword }) { "当前界面包含密码框，请由本人操作" }
                val bounds = Rect(); tree.nodes.getValue("n0").getBoundsInScreen(bounds)
                val expected = Snapshot(UUID.randomUUID().toString(), tree.fingerprint(), tree.packageName, tree.windowId, version, SystemClock.elapsedRealtime(), epoch)
                snapshot = expected
                takeScreenshot(android.view.Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
                    override fun onSuccess(result: ScreenshotResult) {
                        try {
                            checkedScreen(owner, epoch, JSONObject().put("snapshotId", expected.id)).use { current ->
                                check(current.nodes.values.none { it.isPassword }) { "当前界面包含密码框" }
                                done(PhoneScreenshot.encode(result, bounds).put("status", "screenshot").put("snapshotId", expected.id).put("epoch", epoch).put("package", expected.packageName))
                            }
                        } catch (error: Throwable) { snapshot = null; done(JSONObject().put("status", "failed").put("error", error.message)) }
                        finally { result.hardwareBuffer.close() }
                    }
                    override fun onFailure(errorCode: Int) { snapshot = null; done(JSONObject().put("status", "failed").put("error", "系统未允许截图（$errorCode）；安全窗口或请求过快时，请改用 read，不要假装已看到画面")) }
                })
            }; return
        }
        checkedScreen(owner, epoch, args).use { tree ->
            val nodeId = args.optString("nodeId")
            val node = tree.nodes[nodeId]
            val label = if (action in listOf("click", "long_click", "input", "scroll")) tree.label(nodeId) else action
            if (node != null) check(node.isVisibleToUser && node.isEnabled && !node.isPassword) { "元素不可操作或是密码输入框" }
            if (action == "click") check(node?.isClickable == true) { "该元素不是按钮，请选择可点击元素" }
            if (action == "long_click") check(node?.isLongClickable == true) { "该元素不支持长按，请用 long_press 坐标手势" }
            val approved = grant.continuous || confirmed || (args.has("confirmationId") && ControlRuntime.consumeConfirmation(owner, epoch, args, tree.fingerprint()))
            if (!approved && ControlRisk.needsConfirmation(action, label)) {
                val summary = if (action in listOf("tap", "swipe")) "$action：(${args.opt("x")}, ${args.opt("y")})" + (if (action == "swipe") " → (${args.opt("endX")}, ${args.opt("endY")})" else "") else "$action：${label.ifBlank { "无文字按钮" }}"
                done(ControlRuntime.confirmation(owner, epoch, args, summary, tree.packageName, tree.fingerprint())); return
            }
            ControlRuntime.lease.check(owner, tree.packageName, epoch)
            val ok = when (action) {
                "click" -> { check(node?.isClickable == true) { "该元素不是按钮，请选择可点击元素" }; node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK) }
                "long_click" -> node!!.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_LONG_CLICK)
                "input" -> {
                    check(node?.isEditable == true) { "该元素不是可编辑输入框" }
                    val text = args.getString("text"); require(text.length <= 4000) { "输入内容最多 4000 字" }
                    node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) })
                }
                "scroll" -> {
                    check(node?.isScrollable == true) { "请选择可滚动元素" }
                    check(args.optString("direction") in listOf("forward", "backward")) { "滚动方向无效" }
                    node.performAction(if (args.getString("direction") == "backward") android.view.accessibility.AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD else android.view.accessibility.AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
                }
                "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
                "tap", "swipe", "long_press" -> {
                    val bounds = Rect(); tree.nodes.getValue("n0").getBoundsInScreen(bounds)
                    fun coordinate(key: String, horizontal: Boolean): Float {
                        val v = args.getDouble(key); require(v.isFinite()) { "坐标必须是有限数字" }
                        require(v >= (if (horizontal) bounds.left else bounds.top) && v < (if (horizontal) bounds.right else bounds.bottom)) { "坐标超出当前 App 界面" }
                        return v.toFloat()
                    }
                    val path = Path().apply { moveTo(coordinate("x", true), coordinate("y", false)); if (action == "swipe") lineTo(coordinate("endX", true), coordinate("endY", false)) }
                    val gesture = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, when (action) { "tap" -> 60; "long_press" -> 800; else -> 300 })).build()
                    snapshot = null; gestureBusy = true
                    val dispatched = dispatchGesture(gesture, object : GestureResultCallback() {
                        override fun onCompleted(description: GestureDescription?) { gestureBusy = false; done(JSONObject().put("status", if (ControlRuntime.lease.current()?.epoch == epoch) "performed" else "stopped_after_dispatch").put("action", action)) }
                        override fun onCancelled(description: GestureDescription?) { gestureBusy = false; done(JSONObject().put("status", "gesture_cancelled").put("action", action)) }
                    }, null)
                    if (!dispatched) { gestureBusy = false; error("系统没有执行该手势") }
                    return
                }
                else -> error("不支持的手机操作")
            }
            snapshot = null
            check(ok) { "App 未接受该操作，请重新读取界面；不要自动重试提交操作" }
            done(JSONObject().put("status", "performed").put("action", action).put("hint", "请重新读取界面核对实际结果"))
        }
    }
    fun showStop() {
        if (stopView != null) return
        val button = TextView(this).apply {
            text = "■ 停止操作"; textSize = 14f; setTextColor(android.graphics.Color.WHITE)
            setBackgroundColor(android.graphics.Color.rgb(153, 27, 27)); setPadding(20, 16, 20, 16)
            filterTouchesWhenObscured = true; setOnClickListener { ControlRuntime.stop("用户停止") }
        }
        val params = WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            android.graphics.PixelFormat.TRANSLUCENT).apply { gravity = Gravity.TOP or Gravity.END; y = 160 }
        (getSystemService(WINDOW_SERVICE) as WindowManager).addView(button, params); stopView = button
    }
    private fun hideStop() { stopView?.let { runCatching { (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(it) } }; stopView = null }
}
