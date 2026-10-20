package com.dshphone

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.ContextWrapper
import android.os.Bundle
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import org.json.JSONException
import org.json.JSONObject

/** Runs the actual Android launcher in a separate, disposable application UID. */
class StartupInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        start()
    }

    override fun onStart() {
        try {
            val direct = targetContext
            check(direct.packageName.startsWith("com.dshphone.startupverification."))
            launchAndStop(direct, "fresh install through Android Context")

            val alias = File(direct.cacheDir, "runtime-alias")
            Files.createSymbolicLink(alias.toPath(), direct.filesDir.toPath())
            check(alias.absolutePath != alias.canonicalPath)
            val aliased = object : ContextWrapper(direct) {
                override fun getFilesDir(): File = alias
            }
            reproduceOldEntrypoint(aliased)
            launchAndStop(aliased, "absolute launcher path through directory alias")

            val home = NodeRunner.homeDir(aliased)
            val marker = File(home, "user-data-preservation-marker").apply { writeText("keep user data") }
            val sdk = File(home, "profiles/phone/node_modules/@deepseek-ai/dsh-llm")
            if (Files.isSymbolicLink(sdk.toPath())) Files.delete(sdk.toPath())
            else check(!sdk.exists() || sdk.deleteRecursively())
            sdk.mkdirs()
            File(sdk, "package.json").writeText("""{"name":"@deepseek-ai/dsh-llm","version":"0.1.0-rc.8"}""")
            File(sdk, "old-sdk-marker").writeText("recoverable original")
            launchAndStop(aliased, "old SDK upgrade through directory alias")
            check(JSONObject(File(sdk, "package.json").readText()).getString("version") == "0.2.1-alpha.1")
            check(Files.isSymbolicLink(sdk.toPath()))
            check(File(home, ".phone-core-backups").walkTopDown().any {
                it.name == "old-sdk-marker" && it.readText() == "recoverable original"
            })
            check(marker.readText() == "keep user data")
            launchAndStop(aliased, "second startup after SDK upgrade")
            check(marker.readText() == "keep user data")
            check(DshService.snapshotLogs().any { it.contains("迁移 1 个旧模块入口") })
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "DSH_STARTUP_TESTS_OK\n") })
        } catch (error: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply {
                putString("stream", "DSH_STARTUP_TESTS_FAILED: ${error.javaClass.simpleName}: ${error.message}\n")
            })
        }
    }

    private fun launchAndStop(ctx: Context, label: String) {
        val logCount = DshService.snapshotLogs().size
        // The returned engine is stopped immediately, before loading plugins
        // or binding ports. Only extraction, migration and preflight run here.
        val child = NodeRunner.start(ctx)
        try {
            check(DshService.snapshotLogs().drop(logCount).any { it.startsWith("运行库检查完成：") })
        } finally {
            child.destroy()
            if (!child.waitFor(5, TimeUnit.SECONDS)) {
                child.destroyForcibly()
                check(child.waitFor(5, TimeUnit.SECONDS))
            }
        }
        sendStatus(0, Bundle().apply { putString("stream", "PASS: $label\n") })
    }

    private fun reproduceOldEntrypoint(ctx: Context) {
        val script = File(NodeRunner.treeDir(ctx), "migration-before.mjs")
        ctx.assets.open("core-migration-before.js").use { input -> script.outputStream().use { input.copyTo(it) } }
        val output = File(ctx.cacheDir, "migration-before-output.log")
        val builder = ProcessBuilder(File(ctx.applicationInfo.nativeLibraryDir, "libnode.so").absolutePath, script.absolutePath)
        builder.directory(NodeRunner.treeDir(ctx))
        builder.environment().apply {
            put("DSH_HOME", NodeRunner.homeDir(ctx).absolutePath)
            put("HOME", NodeRunner.homeDir(ctx).absolutePath)
            put("TMPDIR", NodeRunner.tmpDir(ctx).absolutePath)
            put("OPENSSL_CONF", "/dev/null")
            put("LD_LIBRARY_PATH", ctx.applicationInfo.nativeLibraryDir)
        }
        builder.redirectErrorStream(true)
        builder.redirectOutput(output)
        val child = builder.start()
        try {
            check(child.waitFor(30, TimeUnit.SECONDS))
            check(child.exitValue() == 0 && output.readText().isEmpty())
            try {
                JSONObject(output.readText())
                error("Expected the old empty-output JSON error")
            } catch (error: JSONException) {
                check(error.message.orEmpty().startsWith("End of input at character 0"))
            }
        } finally {
            if (child.isAlive) { child.destroyForcibly(); child.waitFor(5, TimeUnit.SECONDS) }
            output.delete()
            script.delete()
        }
        sendStatus(0, Bundle().apply { putString("stream", "PASS: reproduced 0.1.26 empty-output error on Android\n") })
    }
}
