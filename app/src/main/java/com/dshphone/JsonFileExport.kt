package com.dshphone

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import org.json.JSONObject
import java.util.concurrent.Executor

/** Pull JSON from the requesting top frame, then save through the system picker.
 * No JavaScript interface is exposed to provider pages or embedded frames.
 */
class JsonFileExport(private val activity: Activity, private val worker: Executor) {
    companion object {
        const val REQUEST_CODE = 2403
        const val MAX_BYTES = 524288
        fun trusted(url: String?): Boolean = runCatching {
            val uri = Uri.parse(url ?: return false)
            uri.scheme == "http" && uri.host == "127.0.0.1" && uri.userInfo == null && uri.port in listOf(3080, 3081)
        }.getOrDefault(false)

        fun payload(raw: String): Pair<String, ByteArray> {
            check(raw.length <= MAX_BYTES * 6 + 1024) { "备份文件过大" }
            val value = JSONObject(raw)
            val name = value.getString("filename")
            check(name.length in 1..160 && name.endsWith(".json") && !name.startsWith(".") &&
                name.none { it == '/' || it == '\\' || it.code < 32 || it.code == 127 }) { "备份文件名无效" }
            val text = value.getString("text")
            val bytes = text.toByteArray(Charsets.UTF_8)
            check(bytes.size in 1..MAX_BYTES) { "备份文件超过手机保存上限（512 KB）" }
            JSONObject(text) // Reject a missing, consumed or malformed payload before opening a picker.
            return name to bytes
        }
    }
    private data class Pending(val view: WebView, val source: String, val ticket: String, var bytes: ByteArray? = null, var writing: Boolean = false)
    private var pending: Pending? = null
    private val handler = Handler(Looper.getMainLooper())
    private var destroyed = false

    fun request(view: WebView, ticket: String) {
        if (destroyed || !trusted(view.url) || !ticket.matches(Regex("[a-f0-9]{32}"))) return
        val job = Pending(view, view.url!!, ticket)
        val current = pending
        if (current != null) {
            if (current.view !== view || current.ticket != ticket) notify(job, "error", "请先完成当前文件的保存")
            return
        }
        pending = job
        view.evaluateJavascript("window.__dshPhoneJsonExport?.take(${JSONObject.quote(ticket)}) ?? null") { raw ->
            if (destroyed || pending !== job) return@evaluateJavascript
            try {
                check(view.url == job.source && trusted(view.url)) { "页面已改变，请返回 Jet Hub 重试" }
                val (name, bytes) = payload(raw)
                job.bytes = bytes
                activity.startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "application/json"
                    putExtra(Intent.EXTRA_TITLE, name)
                    putExtra(android.provider.DocumentsContract.EXTRA_INITIAL_URI,
                        Uri.parse("content://com.android.externalstorage.documents/document/primary%3ADownload"))
                    addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                }, REQUEST_CODE)
            } catch (_: Exception) {
                finish(job, "error", "无法打开保存文件窗口，请返回 Jet Hub 重试")
            }
        }
    }

    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQUEST_CODE) return false
        val job = pending ?: return true
        if (job.writing) return true
        if (resultCode != Activity.RESULT_OK) { finish(job, "cancelled"); return true }
        val uri = data?.data
        val bytes = job.bytes
        if (uri?.scheme != "content" || bytes == null) { finish(job, "error", "文件保存失败，请重试"); return true }
        job.writing = true
        job.bytes = null // The worker owns these bytes until the stream has closed.
        worker.execute {
            val saved = runCatching {
                activity.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) } ?: error("No output stream")
            }.isSuccess
            if (!saved) runCatching { activity.contentResolver.delete(uri, null, null) }
            bytes.fill(0)
            handler.post { finish(job, if (saved) "saved" else "error", if (saved) "" else "文件保存失败，请重试") }
        }
        return true
    }

    private fun notify(job: Pending, status: String, message: String) {
        if (!destroyed && job.view.url == job.source && trusted(job.view.url)) {
            job.view.evaluateJavascript("window.__dshPhoneJsonExport?.complete(${JSONObject.quote(job.ticket)}, ${JSONObject.quote(status)}, ${JSONObject.quote(message)})", null)
        }
    }
    private fun finish(job: Pending, status: String, message: String = "") {
        if (pending !== job) return
        pending = null
        job.bytes?.fill(0); job.bytes = null
        notify(job, status, message)
    }
    fun destroy() {
        destroyed = true
        pending?.bytes?.fill(0); pending = null
    }
}
