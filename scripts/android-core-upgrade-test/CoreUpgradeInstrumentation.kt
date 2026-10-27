package com.dshphone

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import java.io.File
import java.util.concurrent.TimeUnit

/** No production components or permissions; every byte lives in this new test UID. */
class CoreUpgradeInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        try {
            val ctx = targetContext
            check(Regex("com\\.dshphone\\.mcpupgradeverification\\.t[a-f0-9]{32}").matches(ctx.packageName))
            check(Process.myUid() >= 10000)
            val payload = File(ctx.cacheDir, "payload.tar.gz")
            ctx.assets.open("payload.bin").use { input -> payload.outputStream().use { input.copyTo(it) } }
            val unpackLog = File(ctx.cacheDir, "unpack.log")
            val unpack = ProcessBuilder("/system/bin/tar", "-xzf", payload.absolutePath, "-C", ctx.filesDir.absolutePath)
                .redirectErrorStream(true).redirectOutput(unpackLog).start()
            check(unpack.waitFor(180, TimeUnit.SECONDS) && unpack.exitValue() == 0) { "Private fixture extraction failed: ${unpackLog.readText().takeLast(1200)}" }
            payload.delete()
            val script = File(ctx.filesDir, "core-upgrade-probe.mjs")
            ctx.assets.open("core-upgrade-probe.mjs").use { input -> script.outputStream().use { input.copyTo(it) } }
            val log = File(ctx.cacheDir, "core-upgrade.log")
            val native = ctx.applicationInfo.nativeLibraryDir
            val home = File(ctx.filesDir, "home")
            val tmp = File(ctx.filesDir, "tmp").apply { mkdirs() }
            val pb = ProcessBuilder(File(native, "libnode.so").absolutePath, "--expose-internals", "--no-warnings", script.absolutePath)
            pb.directory(File(ctx.filesDir, "tree"))
            pb.environment().apply {
                put("LD_LIBRARY_PATH", native); put("DSH_PHONE_FLOCK", File(native,"libdshflock.so").absolutePath)
                put("DSH_PHONE_ANDROID","1"); put("DSH_PHONE_FILES",ctx.filesDir.absolutePath)
                put("DSH_HOME",home.absolutePath); put("HOME",home.absolutePath); put("TMPDIR",tmp.absolutePath)
                put("DSH_TEST_PACKAGE",ctx.packageName); put("DSH_TEST_UID",Process.myUid().toString())
                put("OPENSSL_CONF","/dev/null"); put("PATH","/system/bin")
            }
            pb.redirectErrorStream(true).redirectOutput(log)
            val child = pb.start(); val start = SystemClock.elapsedRealtime(); var notice = start
            try {
                while (!child.waitFor(2,TimeUnit.SECONDS)) {
                    check(SystemClock.elapsedRealtime()-start < 720000) { "Android private SDK migration timed out" }
                    if (SystemClock.elapsedRealtime()-notice > 15000) {
                        sendStatus(0,Bundle().apply { putString("stream","ANDROID_CORE_PROGRESS ${SystemClock.elapsedRealtime()-start}ms\n") });notice=SystemClock.elapsedRealtime()
                    }
                }
                val text=log.readText();sendStatus(0,Bundle().apply { putString("stream",text.takeLast(240000)) })
                check(child.exitValue()==0 && text.contains("DSH_ANDROID_CORE_OK ")) { "Actual Android core probe failed, exit=${child.exitValue()}" }
            } finally { if(child.isAlive){ child.destroyForcibly();child.waitFor(5,TimeUnit.SECONDS) } }
            finish(Activity.RESULT_OK,Bundle().apply { putString("stream","DSH_ANDROID_CORE_INSTRUMENTATION_OK\n") })
        } catch(error:Throwable){finish(Activity.RESULT_CANCELED,Bundle().apply { putString("stream","DSH_ANDROID_CORE_FAILED: ${error.javaClass.simpleName}: ${error.message}\n") })}
    }
}
