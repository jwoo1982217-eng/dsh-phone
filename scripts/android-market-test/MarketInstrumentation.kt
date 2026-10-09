package com.dshphone

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

class MarketInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    private fun report(name: String) = sendStatus(0, Bundle().apply { putString("stream", "PASS: $name\n") })
    override fun onStart() {
        try {
            val ctx = targetContext
            check(ctx.packageName.startsWith("com.dshphone.marketverification."))
            NodeRunner.ensureExtracted(ctx)
            val home = NodeRunner.homeDir(ctx)
            val credential = File(home, ".credentials.yaml").apply { writeText("newest fixture login") }
            val conversation = File(home, "sessions/fixture/latest.txt").apply { parentFile!!.mkdirs(); writeText("newest fixture reply") }
            val profile = File(home, "profiles/phone/package.json")
            val original = JSONObject(profile.readText()).getJSONObject("dsh").getJSONObject("profile").getJSONArray("bundles").toString()
            val archive = File(ctx.filesDir, "fixture.tgz")
            ctx.assets.open("fixture.tgz").use { input -> archive.outputStream().use { input.copyTo(it) } }
            val driver = File(ctx.filesDir, "trial-driver.mjs")
            ctx.assets.open("driver.mjs").use { input -> driver.outputStream().use { input.copyTo(it) } }
            fun install(mode: String): JSONObject {
                val log = File(ctx.filesDir, "trial-result.log")
                val builder = ProcessBuilder(File(ctx.applicationInfo.nativeLibraryDir, "libnode.so").absolutePath,
                    "--expose-internals", "--no-warnings", driver.absolutePath, home.absolutePath,
                    NodeRunner.treeDir(ctx).absolutePath, archive.absolutePath, mode)
                builder.environment().putAll(NodeRunner.prepareEnvironment(ctx))
                builder.directory(NodeRunner.treeDir(ctx)); builder.redirectErrorStream(true); builder.redirectOutput(log)
                val child = builder.start()
                check(child.waitFor(90, TimeUnit.SECONDS)) { "isolated trial timed out" }
                val result = JSONObject(log.readText().lineSequence().filter { it.isNotBlank() }.last())
                if (mode == "good") check(child.exitValue() == 0 && result.getBoolean("ok")) { result.optString("error") }
                else check(child.exitValue() != 0 && !result.getBoolean("ok"))
                return result
            }
            RecoveryManager.backup(ctx)
            report("full APK environment backup completed before plugin installation")
            install("good")
            val bundles = JSONObject(profile.readText()).getJSONObject("dsh").getJSONObject("profile").getJSONArray("bundles")
            check((0 until bundles.length()).any { bundles.getString(it) == "fixture-phone-trial" })
            val target = File(home, "profiles/phone/node_modules/fixture-phone-trial")
            check(target.exists() && target.canonicalPath.contains("market-plugins/"))
            check(credential.readText() == "newest fixture login" && conversation.readText() == "newest fixture reply")
            report("actual Android Node and bundled pnpm installed fixed JS plugin without running install hooks or changing accounts")
            credential.writeText("new login after trial"); conversation.writeText("new reply after trial")
            RecoveryManager.restore(ctx, "latest")
            check(!target.exists())
            check(JSONObject(profile.readText()).getJSONObject("dsh").getJSONObject("profile").getJSONArray("bundles").toString() == original)
            check(credential.readText() == "new login after trial" && conversation.readText() == "new reply after trial")
            report("native rollback removed trial plugin while retaining newest credentials and replies")
            RecoveryManager.backup(ctx)
            val failed = install("bad")
            check(failed.getString("error").contains("校验失败"))
            RecoveryManager.restore(ctx, "latest")
            check(!target.exists() && credential.readText() == "new login after trial")
            report("failed package integrity check never enabled a plugin and restored the pre-install environment")
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "DSH_MARKET_TESTS_OK\n") })
        } catch (error: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("stream", "DSH_MARKET_TESTS_FAILED: ${error.javaClass.simpleName}: ${error.message}\n") })
        }
    }
}
