package com.dshphone

import android.content.Context
import android.util.Log
import java.io.File
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/** Own the Android adaptation outside the independently updated OFM package. */
object OfmCompatibility {
    fun prepare(ctx: Context, node: File, environment: Map<String, String>) {
        val log = File.createTempFile("dsh-ofm-compat-", ".log", NodeRunner.tmpDir(ctx))
        try {
            for (name in listOf("dsh-ofm-compat.mjs", "dsh-ofm-compat-data.json")) {
                val target = File(ctx.filesDir, name)
                val staged = File(ctx.filesDir, "$name.next")
                ctx.assets.open(name).use { input -> staged.outputStream().use { input.copyTo(it) } }
                staged.setReadable(false, false); staged.setWritable(false, false)
                staged.setReadable(true, true); staged.setWritable(true, true)
                check(staged.renameTo(target)) { "Cannot publish Android OFM adapter" }
            }
            val builder = ProcessBuilder(node.absolutePath, File(ctx.filesDir, "dsh-ofm-compat.mjs").absolutePath)
            builder.environment().putAll(environment)
            builder.redirectErrorStream(true).redirectOutput(log)
            val child = builder.start()
            if (!child.waitFor(25, TimeUnit.SECONDS)) {
                child.destroyForcibly(); child.waitFor(3, TimeUnit.SECONDS)
                error("Android OFM compatibility check timed out")
            }
            val output = log.readText()
            check(child.exitValue() == 0) { "Android OFM package shape is unsupported" }
            val report = JSONObject(output.trim()).getJSONObject("ofmPhoneCompatibility")
            check(report.getString("state") == "ready") { "Android OFM adapter was not ready" }
            Log.i("dsh-phone", "OFM Android adapter: ${report.optJSONArray("changed")?.length() ?: 0} program files refreshed")
        } catch (error: Exception) {
            // A failed preparation retains the existing program; it must not
            // stop unrelated models, accounts, or conversations from starting.
            Log.w("dsh-phone", "OFM Android compatibility retained existing plugin", error)
            DshService.appendLog("OFM 手机兼容检查未完成，已保留原插件；请查看日志")
        } finally {
            log.delete()
        }
    }
}
