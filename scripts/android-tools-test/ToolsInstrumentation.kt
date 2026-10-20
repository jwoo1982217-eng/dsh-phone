package com.dshphone

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import java.io.File
import java.util.concurrent.TimeUnit

/** Uses the production launcher environment in a separate application UID. */
class ToolsInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }

    override fun onStart() {
        try {
            val ctx = targetContext
            check(ctx.packageName.startsWith("com.dshphone.toolsverification."))
            NodeRunner.ensureExtracted(ctx)
            val script = File(NodeRunner.treeDir(ctx), "android-tools-smoke.mjs")
            ctx.assets.open("android-tools-smoke.mjs").use { input -> script.outputStream().use { input.copyTo(it) } }
            val output = File(ctx.cacheDir, "tools-result.log")
            val builder = ProcessBuilder(File(ctx.applicationInfo.nativeLibraryDir, "libnode.so").absolutePath,
                "--expose-internals", "--no-warnings", script.absolutePath)
            builder.environment().putAll(NodeRunner.prepareEnvironment(ctx))
            ctx.getExternalFilesDir("tools-verification")?.let {
                builder.environment()["DSH_TEST_EXTERNAL_FILES"] = it.absolutePath
            }
            builder.directory(NodeRunner.treeDir(ctx))
            builder.redirectErrorStream(true)
            builder.redirectOutput(output)
            val child = builder.start()
            try {
                check(child.waitFor(60, TimeUnit.SECONDS)) { "Android tool tests timed out" }
                val text = output.readText()
                sendStatus(0, Bundle().apply { putString("stream", text) })
                check(child.exitValue() == 0 && text.contains("DSH_ANDROID_TOOLS_OK")) { "Android tool verification failed" }
            } finally {
                if (child.isAlive) { child.destroyForcibly(); child.waitFor(5, TimeUnit.SECONDS) }
            }
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "DSH_ANDROID_TOOLS_OK\n") })
        } catch (error: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply {
                putString("stream", "DSH_ANDROID_TOOLS_FAILED: ${error.javaClass.simpleName}: ${error.message}\n")
            })
        }
    }
}
