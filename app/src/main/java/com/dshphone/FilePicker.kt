package com.dshphone

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.Toast

/** Photo/document routing adapted from kelai141/dsh-mobile-apk's AcceptRouting/ConfigTransfer (MIT). */
internal class FilePicker(private val activity: Activity) {
    companion object { const val REQUEST_CODE = 2401 }
    private data class Pending(val view: WebView, val url: String, val callback: ValueCallback<Array<Uri>>, val multiple: Boolean)
    private var pending: Pending? = null
    private var destroyed = false

    fun choose(view: WebView, callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        val url = view.url.orEmpty()
        val page = Uri.parse(url)
        if (page.scheme != "http" || page.host != "127.0.0.1" || page.userInfo != null || page.port !in listOf(3080, 3081)) return false
        // A second request must not take ownership of the first system activity's result.
        if (destroyed || pending != null) { callback.onReceiveValue(null); return true }
        val multiple = params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
        val declared = params.acceptTypes.orEmpty().flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
        val images = declared.isNotEmpty() && declared.all { token ->
            token.startsWith("image/") || token.startsWith(".") &&
                MimeTypeMap.getSingleton().getMimeTypeFromExtension(token.drop(1))?.startsWith("image/") == true
        }
        pending = Pending(view, url, callback, multiple)
        val intent = if (images && Build.VERSION.SDK_INT >= 33) {
            Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*").apply {
                if (multiple) putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, minOf(100, MediaStore.getPickImagesMaxLimit()))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        } else documentIntent(images, multiple)
        try {
            activity.startActivityForResult(intent, REQUEST_CODE)
        } catch (_: android.content.ActivityNotFoundException) {
            try { activity.startActivityForResult(documentIntent(images, multiple), REQUEST_CODE) }
            catch (_: Exception) { unavailable() }
        } catch (_: Exception) { unavailable() }
        return true
    }

    private fun documentIntent(images: Boolean, multiple: Boolean) =
        Intent(if (images) Intent.ACTION_GET_CONTENT else Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            // Unknown Markdown/ZIP provider MIME types must remain selectable.
            type = if (images) "image/*" else "*/*"
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            if (!images) addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
        }

    private fun unavailable() {
        finish(null)
        Toast.makeText(activity, "无法打开文件选择器，请重试或分享文件到 DSH", Toast.LENGTH_LONG).show()
    }

    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQUEST_CODE) return false
        val request = pending ?: return true
        if (resultCode != Activity.RESULT_OK || destroyed || request.view.url != request.url) { finish(null); return true }
        val uris = (data?.clipData?.let { clip -> (0 until minOf(clip.itemCount, 100)).map { clip.getItemAt(it).uri } }
            ?: listOfNotNull(data?.data)).filter { it.scheme == "content" }.distinct().let { if (request.multiple) it else it.take(1) }
        if (data != null && data.flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION != 0 &&
            data.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0) {
            uris.forEach { uri -> runCatching { activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } }
        }
        finish(uris.toTypedArray().takeIf { it.isNotEmpty() })
        return true
    }

    fun cancelFor(view: WebView) { if (pending?.view === view) finish(null) }
    fun destroy() { destroyed = true; finish(null) }
    private fun finish(value: Array<Uri>?) {
        val callback = pending?.callback
        pending = null
        // A callback from an already evicted renderer may itself be unusable.
        runCatching { callback?.onReceiveValue(value) }
    }
}
