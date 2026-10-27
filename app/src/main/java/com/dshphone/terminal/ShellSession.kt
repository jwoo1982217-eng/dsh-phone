package com.dshphone.terminal

import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.RejectedExecutionException

/** No Android or engine dependency. State and process ownership are generation-scoped. */
class ShellSession(private val factory: Factory, private val maxOutputChars: Int = 65536) : AutoCloseable {
    enum class State { IDLE, STARTING, READY, STOPPING, STOPPED, EXITED, FAILED, CLOSED }
    data class Snapshot(val state: State, val status: String, val output: String, val generation: Long)
    fun interface Factory { fun launch(): Child }
    interface Child {
        val stdout: InputStream
        val stdin: OutputStream
        fun waitFor(): Int
        /** Must terminate descendants too; return a visible cleanup warning if incomplete. */
        fun terminate(): String?
    }
    private val lock = Any()
    private var generation = 0L
    private var state = State.IDLE
    private var status = "未连接"
    private var child: Child? = null
    private val output = StringBuilder()
    private var listener: (() -> Unit)? = null
    private val lifecycle = Executors.newSingleThreadExecutor(daemon("dsh-terminal-lifecycle"))
    private val writer = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(8), daemon("dsh-terminal-input"))

    init { require(maxOutputChars in 1024..262144) }
    fun setListener(value: (() -> Unit)?) { synchronized(lock) { listener = value }; changed() }
    fun snapshot(): Snapshot = synchronized(lock) { Snapshot(state, status, output.toString(), generation) }
    private fun changed() { val callback = synchronized(lock) { listener }; runCatching { callback?.invoke() } }
    private fun state(gen: Long, value: State, text: String) {
        synchronized(lock) { if (gen != generation || state == State.CLOSED) return; state=value; status=text }
        changed()
    }
    private fun append(gen: Long, text: String) {
        synchronized(lock) {
            if (gen != generation || state == State.CLOSED) return
            for (c in text) if (c != '\u0007' && c != '\u0000') output.append(if (c == '\r') '\n' else c)
            if (output.length > maxOutputChars) output.delete(0, output.length - maxOutputChars)
            if (output.isNotEmpty() && Character.isLowSurrogate(output[0])) output.deleteCharAt(0)
        }
        changed()
    }
    fun clearOutput() { synchronized(lock) { output.setLength(0) }; changed() }

    /** Reconnect is explicit. Old queued writes/readers cannot reach the replacement shell. */
    fun start() {
        synchronized(lock) {
            if (state == State.CLOSED) return
            val gen = ++generation
            val previous = child; child = null
            state = State.STARTING; status = "正在启动独立 Bash…"
            writer.queue.clear()
            lifecycle.execute {
                val warning = previous?.let { runCatching { it.terminate() }.getOrElse { e -> "旧会话清理失败：${e.message}" } }
                if (warning != null) { state(gen, State.FAILED, warning); return@execute }
                if (synchronized(lock) { generation != gen || state == State.CLOSED }) return@execute
                try {
                    val launched = factory.launch()
                    val accepted = synchronized(lock) {
                        if (generation == gen && state != State.CLOSED) { child=launched; true } else false
                    }
                    if (!accepted) { launched.terminate(); return@execute }
                    state(gen, State.READY, "Bash 已连接 · 非 PTY，按行执行")
                    Thread({ read(gen, launched) }, "dsh-terminal-output-$gen").apply { isDaemon=true; start() }
                    Thread({
                        try {
                            val code = launched.waitFor()
                            state(gen, State.EXITED, "Bash 已退出（$code），可重新连接")
                        } catch (e: Exception) { state(gen, State.FAILED, "等待命令行失败：${e.message}") }
                    }, "dsh-terminal-exit-$gen").apply { isDaemon=true; start() }
                } catch (e: Exception) { state(gen, State.FAILED, "终端启动失败：${e.message ?: e.javaClass.simpleName}") }
            }
        }
        changed()
    }
    private fun read(gen: Long, launched: Child) {
        try {
            launched.stdout.reader(Charsets.UTF_8).use { reader ->
                val buffer = CharArray(2048)
                while (true) {
                    val count = reader.read(buffer)
                    if (count < 0) break
                    append(gen, String(buffer, 0, count))
                }
            }
        } catch (e: Exception) {
            if (synchronized(lock) { generation == gen && state == State.READY })
                state(gen, State.FAILED, "终端输出中断：${e.message}")
        }
    }
    /** 8 KiB and bounded queue prevent a sleeping command from filling the app heap. */
    fun submit(command: String): Boolean {
        if (command.isBlank() || command.length > 8192 || command.indexOf('\u0000') >= 0) return false
        synchronized(lock) {
            if (state != State.READY) return false
            val gen = generation; val target = child ?: return false
            try {
                writer.execute {
                    if (synchronized(lock) { generation != gen || child !== target || state != State.READY }) return@execute
                    try {
                        append(gen, "\n$ " + command + "\n")
                        target.stdin.write((command + "\n").toByteArray(Charsets.UTF_8)); target.stdin.flush()
                    } catch (e: Exception) { state(gen, State.FAILED, "命令写入失败：${e.message}") }
                }
            } catch (_: RejectedExecutionException) { return false }
        }
        return true
    }
    fun stop() = end(false)
    override fun close() = end(true)
    private fun end(closing: Boolean) {
        synchronized(lock) {
            if (state == State.CLOSED) return
            val gen = ++generation; val previous = child; child = null
            state = if (closing) State.CLOSED else State.STOPPING
            status = if (closing) "终端已关闭" else "正在停止终端及其命令…"
            writer.queue.clear()
            lifecycle.execute {
                val warning = previous?.let { runCatching { it.terminate() }.getOrElse { e -> "清理失败：${e.message}" } }
                if (!closing) state(gen, if (warning == null) State.STOPPED else State.FAILED, warning ?: "终端已停止，可重新连接")
            }
            if (closing) { listener=null; lifecycle.shutdown(); writer.shutdownNow() }
        }
        changed()
    }
    companion object {
        private fun daemon(name: String) = ThreadFactory { runnable -> Thread(runnable, name).apply { isDaemon=true } }
    }
}
