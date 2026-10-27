package com.dshphone.terminal

import android.content.Context
import com.dshphone.NodeRunner
import java.io.File
import java.util.concurrent.TimeUnit

/** Starts only the APK's native Bash; never invokes extraction, migration, or the engine. */
class AndroidShellFactory(context: Context) : ShellSession.Factory {
    private val context = context.applicationContext
    override fun launch(): ShellSession.Child {
        val bash = File(context.applicationInfo.nativeLibraryDir, "libbash.so")
        check(bash.isFile && bash.canExecute()) { "缺少内置 Bash，请安装完整 APK；不会重装或覆盖运行环境" }
        val environment = NodeRunner.prepareEnvironment(context)
        val home = NodeRunner.homeDir(context).takeIf { it.isDirectory } ?: context.filesDir
        val receipt = File.createTempFile("terminal-pid-", ".tmp", NodeRunner.tmpDir(context))
        val script = """
            printf '%s' "${'$'}${'$'}" > "${'$'}1" || exit 125
            set -m
            __dsh_terminal_cleanup() {
              trap - EXIT HUP TERM
              local p
              for p in ${'$'}(jobs -pr); do
                kill -TERM -- "-${'$'}p" 2>/dev/null || kill -TERM "${'$'}p" 2>/dev/null
              done
            }
            trap __dsh_terminal_cleanup EXIT HUP TERM
            . /proc/self/fd/0
        """.trimIndent()
        val builder = ProcessBuilder(bash.absolutePath, "--noprofile", "--norc", "-c", script,
            "dsh-native-terminal", receipt.absolutePath)
        builder.directory(home).redirectErrorStream(true)
        builder.environment().putAll(environment)
        builder.environment()["TERM"] = "dumb"
        // Avoid startup hooks inherited from another environment; this terminal only runs typed commands.
        builder.environment().remove("BASH_ENV"); builder.environment().remove("ENV")
        var process: Process? = null
        try {
            val launched = builder.start(); process = launched
            var pid: Int? = null
            val deadline = System.nanoTime()+TimeUnit.SECONDS.toNanos(2)
            while (pid == null && System.nanoTime()<deadline && launched.isAlive) {
                pid = receipt.readText().trim().toIntOrNull()?.takeIf { it > 1 }
                if (pid == null) Thread.sleep(10)
            }
            val identity = pid?.let { readIdentity(it) }
            check(identity != null) { "不能确认终端进程身份，已停止启动以避免遗留后台进程" }
            return AndroidChild(launched, identity)
        } catch (e: Exception) {
            process?.destroyForcibly()
            process?.waitFor(1, TimeUnit.SECONDS)
            throw e
        } finally { receipt.delete() }
    }
    private class AndroidChild(private val process: Process, private val identity: ProcessTree.Identity) : ShellSession.Child {
        override val stdout = process.inputStream
        override val stdin = process.outputStream
        override fun waitFor() = process.waitFor()
        @Synchronized override fun terminate(): String? {
            val ownIdentity = readIdentity(identity.pid)
            var warning: String? = null
            val descendants = if (ownIdentity == identity) {
                val entries = File("/proc").listFiles()
                if (entries == null) { warning="进程目录不可读，子进程清理范围待核对"; emptyList() }
                else ProcessTree.descendants(identity, entries.asSequence().take(32768)
                    .mapNotNull { it.name.toIntOrNull()?.let(::readIdentity) }.toList())
            } else emptyList()
            for (descendant in descendants) if (!signalIfSame(descendant, 15)) warning="部分子进程停止信号失败，请核对进程状态"
            process.destroy()
            if (!process.waitFor(300, TimeUnit.MILLISECONDS)) process.destroyForcibly()
            // Recheck original identities after TERM: never signal an unrelated reused PID.
            for (descendant in descendants) if (!signalIfSame(descendant, 9)) warning="部分子进程强制停止失败，请核对进程状态"
            if (!process.waitFor(1, TimeUnit.SECONDS)) warning="终端进程未在期限内退出，请核对应用进程状态"
            runCatching { stdin.close() }; runCatching { stdout.close() }; runCatching { process.errorStream.close() }
            if (warning != null) android.util.Log.w("dsh-terminal", warning)
            return warning
        }
        private fun signalIfSame(target: ProcessTree.Identity, signal: Int): Boolean {
            if (readIdentity(target.pid) != target) return true
            return runCatching { android.os.Process.sendSignal(target.pid, signal); true }.getOrDefault(false)
        }
    }
    companion object {
        private fun readIdentity(pid: Int): ProcessTree.Identity? = runCatching {
            ProcessTree.parse(pid, File("/proc/$pid/stat").readText())
        }.getOrNull()
    }
}
