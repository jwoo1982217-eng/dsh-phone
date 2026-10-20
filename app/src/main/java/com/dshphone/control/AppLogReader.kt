package com.dshphone.control

import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.io.ByteArrayOutputStream

/** Fixed, read-only argv. No shell, command parameter, log clearing or unfiltered fallback. */
object AppLogReader {
    fun command(uid: Int, lines: Int): List<String> {
        require(uid >= 10000) { "只读取独立应用 UID 的日志；系统共享 UID 无法按 App 隔离" }
        require(lines in 1..1000) { "日志行数为 1–1000" }
        return listOf("/system/bin/logcat", "-d", "--uid=$uid", "-t", lines.toString(), "-v", "threadtime", "-b", "main", "-b", "system", "-b", "crash")
    }
    fun read(uid: Int, lines: Int): String {
        val process = ProcessBuilder(command(uid, lines)).redirectErrorStream(true).start()
        val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "dsh-app-log-read").apply { isDaemon = true } }
        try {
            val output = worker.submit<String> {
                val bytes = process.inputStream.use { input ->
                    val out = ByteArrayOutputStream(); val buffer = ByteArray(4096)
                    while (true) { val n = input.read(buffer); if (n < 0) break; check(out.size() + n <= 128 * 1024) { "日志过大，请减少行数" }; out.write(buffer, 0, n) }
                    out.toByteArray()
                }
                check(bytes.size <= 128 * 1024) { "日志过大，请减少行数" }
                String(bytes, Charsets.UTF_8)
            }.get(8, TimeUnit.SECONDS)
            check(process.waitFor(1, TimeUnit.SECONDS) && process.exitValue() == 0) { "日志读取失败，请检查 Shizuku 授权" }
            return redact(output)
        } finally { process.destroyForcibly(); worker.shutdownNow() }
    }
    fun redact(text: String): String = text
        .replace(Regex("(?i)(Bearer\\s+)[A-Za-z0-9._~+/-]+"), "$1[已隐藏]")
        .replace(Regex("(?i)((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|set-cookie)[\\\"'\\s]*[:=][\\\"'\\s]*)[^\\r\\n,}]+"), "$1[已隐藏]")
        .replace(Regex("\\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)\\b"), "[已隐藏]")
}
