package com.dshphone.control

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CompletableFuture

/** All platform operations are serialized on Android's main looper. */
object ControlRuntime {
    private val handler = Handler(Looper.getMainLooper())
    private var context: Context? = null
    var service: PhoneControlService? = null
    val lease = ControlLease({ SystemClock.elapsedRealtime() }, { blocked(it) })
    private data class Confirmation(val id: String, val owner: String, val epoch: Long, val args: JSONObject, val label: String, val packageName: String, val fingerprint: String, val deadline: Long)
    private var pendingAction: Confirmation? = null
    private val receipts = linkedMapOf<String, JSONObject>()
    private val receiptArgs = linkedMapOf<String, String>()
    private val cancelled = linkedSetOf<String>()
    private var stoppedAt = 0L
    private var lastResult = JSONObject().put("status", "off")
    private val ticker = object : Runnable {
        override fun run() {
            if (lease.current() == null) { stop("授权到期"); return }
            handler.postDelayed(this, 1000)
        }
    }
    fun attach(ctx: Context) { context = ctx.applicationContext }
    fun blocked(packageName: String): Boolean {
        if (packageName in setOf(context?.packageName.orEmpty(), "android", "com.android.systemui", "com.android.settings", "moe.shizuku.privileged.api") ||
            packageName.contains("permissioncontroller") || packageName.contains("packageinstaller")) return true
        val ctx = context ?: return true
        val homes = ctx.packageManager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0)
        return homes.any { it.activityInfo.packageName == packageName }
    }
    fun apps(): JSONArray {
        val ctx = context ?: error("手机操作模块尚未启动")
        val rows = ctx.packageManager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
            .distinctBy { it.activityInfo.packageName }.filter { !blocked(it.activityInfo.packageName) }
            .sortedBy { it.loadLabel(ctx.packageManager).toString() }
        return JSONArray(rows.map { JSONObject().put("package", it.activityInfo.packageName).put("name", it.loadLabel(ctx.packageManager).toString()) })
    }
    fun call(ctx: Context, payload: JSONObject): CompletableFuture<JSONObject> {
        attach(ctx)
        val future = CompletableFuture<JSONObject>()
        handler.post {
            if (future.isCancelled) return@post
            try {
                val owner = payload.optString("owner")
                when (payload.getString("command")) {
                    "status" -> future.complete(status(owner))
                    "session" -> {
                        syncSession(owner, payload.getString("mode"), payload.optLong("intentAt", 0))
                        future.complete(status(owner))
                    }
                    "browser" -> {
                        val grant = lease.check(owner)
                        val method = payload.getString("method")
                        check(method in setOf("status", "open", "read", "screenshot", "close", "scroll", "back", "forward", "reload") || grant.policyMode == "danger-full-access") { "浏览器点击和输入请使用当前聊天完全权限" }
                        val window = payload.getString("window")
                        require(window.matches(Regex("mcp_[a-f0-9]{40}"))) { "浏览器窗口无效" }
                        com.dshphone.browser.BrowserClient.call(ctx, window, method, payload.optJSONObject("args") ?: JSONObject()).whenComplete { value, error ->
                            if (error != null) future.completeExceptionally(error) else future.complete(value)
                        }
                    }
                    "logs" -> {
                        require(owner.matches(Regex("[a-zA-Z0-9_-]{1,128}")) && !owner.startsWith("qq-") && !owner.startsWith("cloud-")) { "日志读取只供手机 DSH 普通会话" }
                        val target = payload.getString("package")
                        lease.check(owner, target)
                        val epoch = lease.epoch
                        AppLogs.read(ctx.applicationContext, target, payload.optInt("lines", 200)).whenComplete { value, error ->
                            handler.post {
                                if (future.isCancelled) return@post
                                if (error != null) future.completeExceptionally(error)
                                else if (lease.epoch != epoch || lease.current() == null) future.completeExceptionally(IllegalStateException("日志读取授权已撤回"))
                                else future.complete(value)
                            }
                        }
                    }
                    "request" -> {
                        check(receipts.values.none { it.optString("status") == "running" }) { "上一操作尚未结束，不能切换任务" }
                        check(!TermuxCommands.busy()) { "Termux 命令尚未结束，请先取回结果再切换任务" }
                        val names = payload.getJSONArray("packages"); require(names.length() in 1..8) { "请选择 1–8 个 App" }
                        val packages = (0 until names.length()).map { names.getString(it) }.toSet()
                        val installed = apps(); val available = (0 until installed.length()).map { installed.getJSONObject(it).getString("package") }.toSet()
                        check(available.containsAll(packages)) { "部分 App 没有可打开的入口" }
                        val request = lease.request(owner, payload.getString("task"), packages, payload.optInt("minutes", 10))
                        future.complete(JSONObject().put("status", "approval_required").put("requestId", request.id).put("hint", "外部工具箱任务需要手机原生确认；本机 DSH 使用聊天已有的三种权限模式，无需申请"))
                    }
                    "execute" -> {
                        val id = payload.getString("requestId"); require(id.matches(Regex("[a-f0-9-]{36}"))) { "操作标识无效" }
                        val key = "$owner:$id"
                        val grant = lease.check(owner, expectedEpoch = payload.getLong("epoch"))
                        val signature = payload.getJSONObject("args").toString()
                        receipts[key]?.let { check(receiptArgs[key] == signature) { "同一操作标识不能更改动作" }; future.complete(JSONObject(it.toString())); return@post }
                        check(key !in cancelled) { "本次调用已经取消，未执行" }
                        if (receipts.size >= if (grant.continuous) 4096 else 256) {
                            if (grant.allApps) { lease.clearGrant(); resetTaskData(); error("本轮调用已达上限；重新读取会话权限后可直接继续") }
                            stop("本次操作数量已达上限"); error("本次已执行 256 次调用，请重新申请授权")
                        }
                        check(pendingAction == null) { "有待确认动作，请先在手机操作页确认或取消" }
                        check(receipts.values.none { it.optString("status") == "running" }) { "上一操作尚未结束" }
                        receiptArgs[key] = signature; remember(key, JSONObject().put("status", "running"))
                        try {
                            (service ?: error("请在系统设置启用 DSH 手机操作无障碍服务")).execute(owner, grant.epoch, payload.getJSONObject("args"), false) { result ->
                                remember(key, result); if (lease.current()?.epoch == grant.epoch) lastResult = result; future.complete(result)
                            }
                        } catch (error: Throwable) { remember(key, failure(error)); throw error }
                    }
                    "termux_start" -> { future.complete(TermuxCommands.start(ctx, owner, payload)) }
                    "termux_result" -> future.complete(TermuxCommands.result(owner, payload.getString("jobId")))
                    "cancel" -> {
                        val key = "$owner:${payload.getString("requestId")}"; cancelled.add(key)
                        while (cancelled.size > 256) cancelled.remove(cancelled.first())
                        // Cancellation revokes the caller's entire active lease, including pending confirmations.
                        if (lease.current()?.owner == owner) stop("调用已取消")
                        future.complete(JSONObject().put("status", "cancelled"))
                    }
                    "stop" -> {
                        val active = lease.current(); val request = lease.currentRequest()
                        check((active == null || active.owner == owner) && (request == null || request.owner == owner)) { "不能停止其他会话的授权" }
                        stop("会话结束操作"); future.complete(JSONObject().put("status", "stopped"))
                    }
                    else -> error("无效的手机控制命令")
                }
            } catch (error: Throwable) { future.completeExceptionally(error) }
        }
        return future
    }
    private fun remember(key: String, value: JSONObject) { receipts[key] = JSONObject(value.toString()) }
    private fun failure(error: Throwable) = JSONObject().put("status", "failed").put("error", error.message ?: "操作失败")
    fun status(owner: String = ""): JSONObject {
        val grant = lease.current(); val request = lease.currentRequest()
        if (pendingAction?.deadline?.let { SystemClock.elapsedRealtime() >= it } == true) pendingAction = null
        return JSONObject().put("status", if (grant == null) "off" else "authorized").put("paused", stoppedAt > 0).put("permissionMode", grant?.policyMode ?: JSONObject.NULL).put("accessibilityConnected", service != null).put("logs", AppLogs.status()).put("termux", TermuxCommands.status(context ?: error("手机操作尚未启动"))).put("apps", apps())
            .put("grant", if (grant != null && (owner.isEmpty() || owner == grant.owner)) JSONObject().put("owner", grant.owner).put("task", grant.task).put("epoch", grant.epoch)
                .put("packages", JSONArray(grant.packages.toList())).put("continuous", grant.continuous).put("allApps", grant.allApps).put("policyMode", grant.policyMode ?: JSONObject.NULL).put("remainingSeconds", if (grant.continuous) JSONObject.NULL else (grant.deadline - SystemClock.elapsedRealtime()).coerceAtLeast(0) / 1000) else JSONObject.NULL)
            .put("request", if (request != null && (owner.isEmpty() || owner == request.owner)) JSONObject().put("id", request.id).put("owner", request.owner).put("task", request.task).put("packages", JSONArray(request.packages.toList())).put("minutes", request.minutes) else JSONObject.NULL)
            .put("confirmation", pendingAction?.takeIf { owner.isEmpty() || it.owner == owner }?.let { JSONObject().put("id", it.id).put("label", it.label).put("package", it.packageName) } ?: JSONObject.NULL)
            .put("lastResult", if (owner.isEmpty() || owner == grant?.owner) lastResult else JSONObject.NULL)
    }
    private fun resetTaskData() {
        pendingAction = null; approvedAction = null; receipts.clear(); receiptArgs.clear(); cancelled.clear()
    }
    private fun syncSession(owner: String, mode: String, intentAt: Long) {
        check(stoppedAt == 0L || intentAt > stoppedAt) { "手机操作已停止；等待你发送新的指令或切换会话权限，不会自动继续" }
        val old = lease.current()
        if (old?.owner == owner && old.policyMode == mode) return
        check(old?.owner == owner || receipts.values.none { it.optString("status") == "running" }) { "上一操作尚未结束，请先核对结果" }
        lease.claim(owner, mode); resetTaskData(); TermuxCommands.revoke(); stoppedAt = 0L
        try { service?.showStop() } catch (error: Throwable) { stop("停止按钮无法显示"); throw error }
        handler.removeCallbacks(ticker); handler.postDelayed(ticker, 1000)
    }
    fun approve(id: String) {
        check(service != null) { "请先由本人启用无障碍服务" }
        lease.approve(id); stoppedAt = 0L
        try { service!!.showStop() } catch (error: Throwable) { stop("停止按钮无法显示"); throw error }
        resetTaskData(); lastResult = JSONObject().put("status", "authorized")
        handler.removeCallbacks(ticker); handler.postDelayed(ticker, 1000)
    }
    fun confirmation(owner: String, epoch: Long, args: JSONObject, label: String, packageName: String, fingerprint: String): JSONObject {
        check(pendingAction == null) { "请先处理上一确认" }
        val item = Confirmation(UUID.randomUUID().toString(), owner, epoch, JSONObject(args.toString()), label, packageName, fingerprint, SystemClock.elapsedRealtime() + 120_000)
        pendingAction = item
        return JSONObject().put("status", "confirmation_required").put("confirmationId", item.id).put("hint", "在手机操作页确认该动作，确认后返回 App 并在会话继续；不要重复调用动作")
    }
    fun approveAction(id: String) {
        val item = pendingAction ?: error("动作确认已结束")
        check(item.id == id && SystemClock.elapsedRealtime() < item.deadline) { "确认已过期，请重新读取界面" }
        lease.check(item.owner, item.packageName, item.epoch)
        // Opening this native approval page changes the active window. Approval
        // records consent only; executing still requires a new snapshot of the App.
        pendingAction = null
        approvedAction = item
        lastResult = JSONObject().put("status", "action_approved").put("confirmationId", id).put("hint", "返回目标 App，重新读取界面后调用已确认动作")
    }
    private var approvedAction: Confirmation? = null
    fun consumeConfirmation(owner: String, epoch: Long, args: JSONObject, fingerprint: String): Boolean {
        val item = approvedAction ?: return false
        val original = JSONObject(item.args.toString()).apply { remove("snapshotId") }
        val proposed = JSONObject(args.toString()).apply { remove("snapshotId"); remove("confirmationId") }
        val keys = original.keys().asSequence().toSet()
        val equal = keys == proposed.keys().asSequence().toSet() && keys.all { original.get(it).toString() == proposed.get(it).toString() }
        check(item.owner == owner && item.epoch == epoch && SystemClock.elapsedRealtime() < item.deadline && args.optString("confirmationId") == item.id && item.fingerprint == fingerprint && equal) { "确认与本次动作或界面不匹配，请重新申请确认" }
        approvedAction = null; return true
    }
    fun stop(reason: String) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            lease.stop(); handler.post { stop(reason) }; return
        }
        lease.stop(); stoppedAt = System.currentTimeMillis(); pendingAction = null; approvedAction = null
        TermuxCommands.revoke()
        handler.removeCallbacks(ticker); service?.clear()
        lastResult = JSONObject().put("status", "stopped").put("reason", reason)
    }
}
