package com.dshphone

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import java.io.File
import java.util.concurrent.TimeUnit

/** Uses the production launcher environment in a separate application UID. */
class ImageInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }

    override fun onStart() {
        try {
            val ctx = targetContext
            check(ctx.packageName.startsWith("com.dshphone.imageverification."))
            NodeRunner.ensureExtracted(ctx)
            val script = File(NodeRunner.treeDir(ctx), "android-image-smoke.mjs")
            ctx.assets.open("android-image-smoke.mjs").use { input -> script.outputStream().use { input.copyTo(it) } }
            val fixtures = File(NodeRunner.homeDir(ctx), "image-fixtures").apply { mkdirs() }
            for (name in ctx.assets.list("image-fixtures").orEmpty()) ctx.assets.open("image-fixtures/$name").use { input ->
                File(fixtures, name).outputStream().use { input.copyTo(it) }
            }
            val output = File(ctx.cacheDir, "images-result.log")
            val builder = ProcessBuilder(File(ctx.applicationInfo.nativeLibraryDir, "libnode.so").absolutePath,
                "--expose-internals", "--no-warnings", script.absolutePath)
            builder.environment().putAll(NodeRunner.prepareEnvironment(ctx))
            builder.directory(NodeRunner.treeDir(ctx))
            builder.redirectErrorStream(true)
            builder.redirectOutput(output)
            val child = builder.start()
            try {
                check(child.waitFor(180, TimeUnit.SECONDS)) { "Android image tests timed out" }
                val text = output.readText()
                sendStatus(0, Bundle().apply { putString("stream", text) })
                check(child.exitValue() == 0 && text.contains("DSH_ANDROID_IMAGES_OK")) { "Android image verification failed" }
            } finally {
                if (child.isAlive) { child.destroyForcibly(); child.waitFor(5, TimeUnit.SECONDS) }
            }
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "DSH_ANDROID_IMAGES_OK\n") })
        } catch (error: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply {
                putString("stream", "DSH_ANDROID_IMAGES_FAILED: ${error.javaClass.simpleName}: ${error.message}\n")
            })
        }
    }
}
