package com.dshphone.control

import android.app.PendingIntent
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID

/** Official Termux RUN_COMMAND transport. Commands execute under Termux's UID, never Shizuku. */
object TermuxCommands {
    const val PERMISSION = "com.termux.permission.RUN_COMMAND"
    const val RESULT_BUNDLE = "result"
    private const val PREFIX = "/data/data/com.termux/files/usr/bin/"
    private data class Job(val id: String, val owner: String, val epoch: Long, val requestId: String, val signature: String, val deadline: Long, val callback: PendingIntent, var value: JSONObject)
    private val jobs = linkedMapOf<String, Job>()
    fun openSetup(activity: Activity) {
        AlertDialog.Builder(activity).setTitle("Termux 首次接入")
            .setMessage("官方 Termux 需要打开过并完成初始化。随后开启外部调用：下方复制命令，打开 Termux 后由你粘贴并执行一次，再返回此页授权命令权限。\n\n允许后，完全权限模式下 DSH 可在 Termux 中执行任务命令并读取输出。")
            .setPositiveButton("复制设置命令并打开 Termux") { _, _ ->
                val command = "mkdir -p ~/.termux && printf '\\nallow-external-apps=true\\n' >> ~/.termux/termux.properties && termux-reload-settings"
                (activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("DSH Termux 接入", command))
                activity.startActivity(activity.packageManager.getLaunchIntentForPackage("com.termux") ?: Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/termux/termux-app/releases/latest")))
            }.setNegativeButton("稍后", null).show()
    }
    fun status(ctx: Context): JSONObject {
        val installed = runCatching { ctx.packageManager.getPackageInfo("com.termux", 0); true }.getOrDefault(false)
        val permission = installed && ctx.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED
        return JSONObject().put("installed", installed).put("permissionGranted", permission).put("transportReady", permission)
            .put("hint", if (!installed) "先安装官方 Termux 并打开一次完成初始化" else if (!permission) "在服务→手机操作授权 Termux 命令权限" else "还需在 Termux 设置 allow-external-apps=true；以实际命令结果确认接入成功")
    }
    private fun allowed(owner: String): ControlLease.Grant {
        require(owner.matches(Regex("[a-zA-Z0-9_-]{1,128}")) && !owner.startsWith("qq-") && !owner.startsWith("cloud-")) { "Termux 命令只供手机 DSH 普通会话" }
        val grant = ControlRuntime.lease.check(owner, "com.termux")
        check(grant.policyMode == "danger-full-access") { "执行 Termux 命令需要聊天已有的完全权限模式" }
        return grant
    }
    @Synchronized fun start(ctx: Context, owner: String, args: JSONObject): JSONObject {
        val grant = allowed(owner)
        check(status(ctx).getBoolean("transportReady")) { status(ctx).getString("hint") }
        val requestId = args.getString("requestId"); require(requestId.matches(Regex("[a-f0-9-]{36}"))) { "命令标识无效" }
        val script = args.getString("script"); require(script.isNotBlank() && script.length <= 16000 && !script.contains('\u0000')) { "命令最多 16000 字，不能含空字节" }
        val cwd = args.optString("cwd", "/data/data/com.termux/files/home"); require(cwd.startsWith("/") && cwd.length <= 1024 && !cwd.contains('\u0000')) { "工作目录需要绝对路径" }
        val seconds = args.optInt("seconds", 60); require(seconds in 1..120) { "运行时限为 1–120 秒" }
        val signature = MessageDigest.getInstance("SHA-256").digest(JSONObject().put("script", script).put("cwd", cwd).put("seconds", seconds).toString().toByteArray()).joinToString("") { "%02x".format(it) }
        jobs.values.firstOrNull { it.owner == owner && it.requestId == requestId }?.let {
            check(it.epoch == grant.epoch && it.signature == signature) { "同一命令标识不能改变参数或授权" }; return JSONObject(it.value.toString())
        }
        jobs.values.forEach { expire(it) }
        check(jobs.values.none { it.value.optString("status") == "running" }) { "已有 Termux 命令运行，请先取回结果" }
        while (jobs.size >= 64) { val oldest = jobs.entries.first(); oldest.value.callback.cancel(); jobs.remove(oldest.key) }
        val id = UUID.randomUUID().toString()
        val receiver = Intent(ctx, TermuxResultReceiver::class.java).setData(Uri.parse("dsh-termux-result://job/$id"))
        val callback = PendingIntent.getBroadcast(ctx, 0, receiver, PendingIntent.FLAG_ONE_SHOT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0))
        val job = Job(id, owner, grant.epoch, requestId, signature, SystemClock.elapsedRealtime() + (seconds + 8) * 1000L, callback,
            JSONObject().put("status", "running").put("jobId", id).put("hint", "已提交到 Termux；用 phone_termux_result 读取结果，不要重复提交"))
        jobs[id] = job
        try { ctx.startService(commandIntent(script, cwd, seconds, callback)) }
        catch (error: Throwable) { callback.cancel(); job.value = JSONObject().put("status", "dispatch_failed").put("jobId", id).put("error", error.message ?: "Termux 未接受命令"); throw error }
        return JSONObject(job.value.toString())
    }
    internal fun commandIntent(script: String, cwd: String, seconds: Int, callback: PendingIntent): Intent = Intent("com.termux.RUN_COMMAND")
        .setClassName("com.termux", "com.termux.app.RunCommandService")
        .putExtra("com.termux.RUN_COMMAND_PATH", PREFIX + "timeout")
        .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("--signal=TERM", "--kill-after=3s", "${seconds}s", PREFIX + "bash", "-lc", script))
        .putExtra("com.termux.RUN_COMMAND_WORKDIR", cwd).putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
        .putExtra("com.termux.RUN_COMMAND_COMMAND_LABEL", "DSH 手机任务")
        .putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", callback)
    private fun expire(job: Job) {
        if (job.value.optString("status") == "running" && SystemClock.elapsedRealtime() >= job.deadline) {
            job.callback.cancel(); job.value = JSONObject().put("status", "result_unknown").put("jobId", job.id).put("hint", "未收到命令结果；先在 Termux 检查，不能假定完成或自动重试")
        }
    }
    @Synchronized fun result(owner: String, id: String): JSONObject {
        val job = jobs[id] ?: error("命令记录不存在或应用已重启；先在 Termux 检查实际结果")
        check(job.owner == owner) { "命令属于另一个会话" }; expire(job)
        if (job.value.optString("status") !in listOf("revoked_after_dispatch", "result_unknown")) {
            val grant = allowed(owner); check(grant.epoch == job.epoch) { "本次命令授权已经变化" }
        }
        return JSONObject(job.value.toString())
    }
    @Synchronized fun receive(id: String, bundle: Bundle?) {
        val job = jobs[id] ?: return; expire(job)
        if (job.value.optString("status") != "running") return
        val active = ControlRuntime.lease.current()
        if (active?.owner != job.owner || active.epoch != job.epoch || active.policyMode != "danger-full-access") { revoke(); return }
        val result = bundle ?: run { job.value = JSONObject().put("status", "result_unknown").put("jobId", id); return }
        val stdout = result.getString("stdout").orEmpty(); val stderr = result.getString("stderr").orEmpty()
        val internalError = result.getInt("err", -1)
        job.value = JSONObject().put("status", if (internalError == -1) "completed" else "failed").put("jobId", id)
            .put("exitCode", result.getInt("exitCode", -1)).put("stdout", AppLogReader.redact(stdout).takeLast(48000))
            .put("stderr", AppLogReader.redact(stderr).takeLast(16000)).put("error", AppLogReader.redact(result.getString("errmsg").orEmpty()).take(4000))
            .put("outputTruncated", stdout.length > 48000 || stderr.length > 16000 || result.getInt("stdout_original_length", stdout.length) > stdout.length || result.getInt("stderr_original_length", stderr.length) > stderr.length)
    }
    @Synchronized fun revoke() {
        jobs.values.filter { it.value.optString("status") == "running" }.forEach {
            it.callback.cancel(); it.value = JSONObject().put("status", "revoked_after_dispatch").put("jobId", it.id).put("hint", "已停止接收结果和后续命令；已交给 Termux 的命令可能仍在执行，需要时在 Termux 终止，不能自动重试")
        }
    }
    @Synchronized fun busy(): Boolean { jobs.values.forEach { expire(it) }; return jobs.values.any { it.value.optString("status") == "running" } }
}
