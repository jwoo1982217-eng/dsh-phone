package com.dshphone

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Only a fixed, one-use plan selected through the authenticated local market is accepted. */
object TrialInstaller {
    class StillRunning : IllegalStateException("安装进程尚未退出，待结束后从原生入口恢复环境")
    @Volatile private var installer: Process? = null
    fun running(): Boolean = installer?.isAlive == true
    fun claim(ticket: String, cookie: String): JSONObject = plan(ticket, cookie, "trial-claim")
    fun preview(ticket: String, cookie: String): JSONObject = plan(ticket, cookie, "trial-view")
    fun cancel(ticket: String, cookie: String) { plan(ticket, cookie, "trial-cancel") }
    private fun plan(ticket: String, cookie: String, action: String): JSONObject {
        check(ticket.matches(Regex("[a-f0-9]{64}"))) { "试装确认无效" }
        val connection = URL("http://127.0.0.1:3080/controlled-market/manage").openConnection(Proxy.NO_PROXY) as HttpURLConnection
        try {
            connection.requestMethod = "POST"; connection.doOutput = true
            connection.connectTimeout = 3000; connection.readTimeout = 5000
            connection.setRequestProperty("Cookie", cookie)
            connection.setRequestProperty("Origin", "http://127.0.0.1:3080")
            connection.setRequestProperty("Content-Type", "application/json")
            val request = JSONObject().put("type", "client-request").put("rpcId", UUID.randomUUID().toString()).put("method", "manage")
                .put("payload", JSONObject().put("action", action).put("ticket", ticket))
            connection.outputStream.use { it.write(request.toString().toByteArray(Charsets.UTF_8)) }
            check(connection.responseCode == 200) { "市场授权已过期，请重新选择插件" }
            val result = connection.inputStream.use { input ->
                val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                while (true) { val n = input.read(buffer); if (n < 0) break; check(output.size() + n <= 131072); output.write(buffer, 0, n) }
                JSONObject(output.toString("UTF-8")).getJSONObject("result")
            }
            check(result.getBoolean("ok")) { result.optJSONObject("error")?.optString("message") ?: "试装确认已过期" }
            return result.getJSONObject("value")
        } finally { connection.disconnect() }
    }

    fun install(ctx: Context, plan: JSONObject) {
        val input = File.createTempFile("dsh-trial-", ".json", NodeRunner.tmpDir(ctx))
        val output = File.createTempFile("dsh-trial-", ".log", NodeRunner.tmpDir(ctx))
        try {
            input.writeText(plan.toString()); input.setReadable(false, false); input.setReadable(true, true)
            val script = File(NodeRunner.treeDir(ctx), "node_modules/dsh-peer/controlled-market/install-trial.mjs")
            check(script.isFile) { "试装工具缺失，请更新完整 APK" }
            val builder = ProcessBuilder(File(ctx.applicationInfo.nativeLibraryDir, "libnode.so").absolutePath, "--expose-internals", "--no-warnings", script.absolutePath, input.absolutePath)
            builder.directory(NodeRunner.treeDir(ctx)); builder.environment().putAll(NodeRunner.prepareEnvironment(ctx))
            builder.redirectErrorStream(true); builder.redirectOutput(output)
            val child = builder.start()
            installer = child
            if (!child.waitFor(270, TimeUnit.SECONDS)) {
                child.destroy()
                // The installer terminates its detached package-manager group before exiting.
                if (!child.waitFor(15, TimeUnit.SECONDS)) throw StillRunning()
                error("安装超时，已停止试装")
            }
            val lines = output.readText().lineSequence().filter { it.isNotBlank() }.toList()
            val result = runCatching { JSONObject(lines.lastOrNull() ?: "") }.getOrNull()
            check(child.exitValue() == 0 && result?.optBoolean("ok") == true) { result?.optString("message") ?: "插件安装未完成，请检查网络后重试" }
        } finally { if (!running()) installer = null; input.delete(); output.delete() }
    }
}
