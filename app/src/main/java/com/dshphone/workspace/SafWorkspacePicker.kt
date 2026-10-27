package com.dshphone.workspace

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import com.dshphone.StorageAccess
import java.util.concurrent.atomic.AtomicInteger

/** User-initiated SAF bridge for raw-file workspaces. All entry points run on the Activity main thread. */
internal class SafWorkspacePicker(
    private val activity: Activity,
    private val onResult: (Result) -> Unit,
    private val timeoutMillis: Long = 300_000L,
    private val accessGranted: () -> Boolean = { StorageAccess.granted(activity) },
    private val volumeProvider: () -> List<SafWorkspacePathPolicy.Volume> = { SafWorkspaceStorage.mountedVolumes(activity) },
    private val directoryUsable: (SafWorkspacePathPolicy.Resolved) -> Boolean = SafWorkspaceDirectoryAccess::usable,
    private val persistGrant: (Uri, Int) -> Boolean = { uri, flags -> SafWorkspaceStorage.persistGrant(activity, uri, flags) }
) : AutoCloseable {
    enum class Status { SELECTED, CANCELLED, BUSY, PERMISSION_REQUIRED, UNSUPPORTED, ERROR, TIMEOUT, CLOSED }
    data class Result(val requestId: String, val status: Status, val path: String? = null,
        val uri: String? = null, val persistedGrant: Boolean = false, val message: String? = null)
    private companion object { val nextRequestCode = AtomicInteger(SafWorkspaceSelectionState.CODE_START) }
    private val state = SafWorkspaceSelectionState { nextRequestCode.getAndIncrement() }
    private val handler = Handler(Looper.getMainLooper())
    private var timeout: Runnable? = null
    private var closed = false
    private val readWrite = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION

    init { require(timeoutMillis in 1..300_000L) { "SAF picker timeout must be between 1 ms and 5 minutes" } }

    fun request(requestId: String): Boolean {
        if (closed || activity.isDestroyed || activity.isFinishing)
            return reject(requestId, Status.CLOSED, "页面已关闭，请重新打开工作区选择")
        if (requestId.isBlank() || requestId.length > 256 || requestId.any { it.code < 32 || it.code == 127 })
            return reject(requestId, Status.ERROR, "工作区选择请求无效")
        state.current?.let {
            // Engine polling can repeat one ticket while DocumentsUI is open; that is not a second pick.
            if (it.requestId == requestId) return true
            return reject(requestId, Status.BUSY, "已有文件夹选择进行中")
        }
        if (!runCatching(accessGranted).getOrDefault(false))
            return reject(requestId, Status.PERMISSION_REQUIRED, "请先通过“文件访问权限”允许访问共享文件，再重试选择")
        val lease = state.begin(requestId)
            ?: return reject(requestId, Status.ERROR, "本页目录选择次数已达上限，请重新打开页面")
        timeout = Runnable {
            if (state.current?.code == lease.code) finish(Status.TIMEOUT, "选择文件夹已超时，请重试", dismiss = true)
        }.also { handler.postDelayed(it, timeoutMillis) }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(readWrite or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
        return try {
            activity.startActivityForResult(intent, lease.code)
            true
        } catch (_: Exception) {
            finish(Status.ERROR, "无法打开系统文件夹选择器，请重试", dismiss = false)
            false
        }
    }

    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode !in SafWorkspaceSelectionState.CODE_START..SafWorkspaceSelectionState.CODE_LIMIT) return false
        val lease = state.finish(requestCode) ?: return true
        clearTimeout()
        if (closed || activity.isDestroyed || activity.isFinishing) {
            emit(Result(lease.requestId, Status.CLOSED, message = "页面已关闭")); return true
        }
        if (resultCode != Activity.RESULT_OK || data?.data == null) {
            emit(Result(lease.requestId, Status.CANCELLED)); return true
        }
        val result = try { resolve(lease.requestId, data) }
        catch (_: Exception) { Result(lease.requestId, Status.ERROR, message = "读取所选文件夹失败，请重新选择") }
        emit(result)
        return true
    }

    private fun resolve(id: String, data: Intent): Result {
        val uri = data.data!!
        if (!accessGranted()) return Result(id, Status.PERMISSION_REQUIRED, message = "共享文件访问权限已变更，请重新授权后重试")
        val tree = uri.scheme == "content" && uri.authority == SafWorkspacePathPolicy.EXTERNAL_STORAGE_AUTHORITY &&
            uri.query == null && uri.fragment == null && uri.pathSegments.size == 2 && uri.pathSegments[0] == "tree" &&
            DocumentsContract.isTreeUri(uri)
        val selected = if (tree) SafWorkspacePathPolicy.resolve(uri.authority,
            DocumentsContract.getTreeDocumentId(uri), volumeProvider()) else null
        if (selected == null) return Result(id, Status.UNSUPPORTED,
            message = "此目录不是已挂载的本地存储，请选择内部存储或 SD 卡文件夹；云盘暂不支持文件工具工作区")
        if (!directoryUsable(selected)) return Result(id, Status.ERROR, message = "所选文件夹无法直接读写，请选择其他本地目录")
        if (data.flags and readWrite != readWrite || data.flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION == 0)
            return Result(id, Status.ERROR, message = "系统未提供可持久保存的文件夹读写授权，请重新选择")
        if (!persistGrant(uri, readWrite)) return Result(id, Status.ERROR, message = "无法保存文件夹授权，请重新选择")
        if (!accessGranted() || !directoryUsable(selected)) return Result(id, Status.ERROR,
            message = "文件夹权限或存储状态已变更，请重新选择")
        return Result(id, Status.SELECTED, selected.path, uri.toString(), persistedGrant = true)
    }

    fun cancel() { finish(Status.CANCELLED, dismiss = true) }
    override fun close() {
        if (closed) return
        closed = true
        finish(Status.CLOSED, "页面已关闭", dismiss = true)
        clearTimeout()
    }
    private fun finish(status: Status, message: String? = null, dismiss: Boolean) {
        val lease = state.clear() ?: return
        clearTimeout()
        if (dismiss) runCatching { activity.finishActivity(lease.code) }
        emit(Result(lease.requestId, status, message = message))
    }
    private fun clearTimeout() { timeout?.let { handler.removeCallbacks(it) }; timeout = null }
    private fun reject(id: String, status: Status, message: String): Boolean {
        emit(Result(id, status, message = message)); return false
    }
    private fun emit(result: Result) { runCatching { onResult(result) } }
}
