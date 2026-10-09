package com.dshphone

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.widget.EditText
import android.widget.Toast
import com.journeyapps.barcodescanner.ScanOptions
import com.journeyapps.barcodescanner.ScanIntentResult
import java.net.URI
import java.util.Locale

/** Pocket 的访问密码由电脑页面处理；这里只保存地址，不保存二维码里的密码。 */
class PocketConnection(
    private val activity: Activity,
    private val open: (String) -> Unit,
    private val legacy: () -> Unit,
) {
    private val preferences = activity.getSharedPreferences("pocket-connection", Activity.MODE_PRIVATE)
    fun savedUrl(): String? = preferences.getString("url", null)?.let(::normalize)

    fun openComputer() {
        val saved = savedUrl()
        if (saved != null) open(saved) else showConnections()
    }

    fun showConnections() {
        val saved = savedUrl()
        val choices = mutableListOf<Pair<String, () -> Unit>>()
        if (saved != null) choices.add("打开已连接电脑 · ${URI(saved).host}" to { open(saved) })
        choices.add("扫码连接电脑（Pocket）" to { scan() })
        choices.add("粘贴电脑访问链接" to { paste() })
        choices.add("原设备连接方式" to legacy)
        if (saved != null) choices.add("忘记这台电脑" to {
            preferences.edit().remove("url").apply()
            showConnections()
        })
        AlertDialog.Builder(activity).setTitle("连接电脑")
            .setItems(choices.map { it.first }.toTypedArray()) { _, index -> choices[index].second() }
            .setNegativeButton("取消", null).show()
    }

    @Suppress("DEPRECATION")
    fun scan() {
        val intent = ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setOrientationLocked(false).setBeepEnabled(false)
            .setBarcodeImageEnabled(false)
            .setPrompt("扫描电脑 DSH「设置 → 手机访问」里的二维码")
            .createScanIntent(activity)
        activity.startActivityForResult(intent, REQUEST_CODE)
    }

    private fun paste() {
        val input = EditText(activity).apply {
            hint = "https://… 或 http://电脑局域网地址:3081"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
        }
        val dialog = AlertDialog.Builder(activity).setTitle("电脑访问链接")
            .setMessage("在电脑 DSH「设置 → 手机访问」复制链接；外出使用公网链接。")
            .setView(input).setPositiveButton("连接", null).setNegativeButton("取消", null).create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                if (connect(input.text.toString())) dialog.dismiss()
                else input.error = "请使用电脑 Pocket 生成的公网或局域网链接"
            }
        }
        dialog.show()
    }

    fun connect(raw: String): Boolean {
        val url = normalize(raw) ?: return false
        val uri = URI(url)
        preferences.edit().putString("url", "${uri.scheme}://${uri.rawAuthority}/").apply()
        open(url)
        return true
    }

    @Suppress("DEPRECATION")
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQUEST_CODE) return false
        if (resultCode != Activity.RESULT_OK || data == null) return true
        val result = ScanIntentResult.parseActivityResult(resultCode, data).contents ?: return true
        if (!connect(result)) Toast.makeText(activity,
            "这不是有效的 Pocket 访问链接，请扫描电脑「手机访问」中的二维码", Toast.LENGTH_LONG).show()
        return true
    }

    companion object {
        const val REQUEST_CODE = 2405

        fun normalize(raw: String): String? = runCatching {
            val text = raw.trim()
            require(text.length in 1..2048 && text.none { it <= ' ' || it == '\\' })
            val uri = URI(text)
            val scheme = uri.scheme?.lowercase(Locale.ROOT)
            val host = uri.host?.lowercase(Locale.ROOT) ?: error("No host")
            require(scheme in listOf("https", "http") && uri.rawUserInfo == null && uri.rawFragment == null)
            require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")
            require(uri.port == -1 || uri.port in 1..65535)
            require(host.matches(Regex("[a-z0-9][a-z0-9.-]*[a-z0-9]|[a-z0-9]")))
            require(host != "localhost" && !host.endsWith(".localhost") && host != "0.0.0.0")
            val ip = ipv4(host)
            require(ip != null || host.any { it in 'a'..'z' })
            require(ip == null || ip[0] != 127 && ip[0] != 0)
            require(scheme == "https" || ip != null &&
                (ip[0] == 10 || ip[0] == 192 && ip[1] == 168 || ip[0] == 172 && ip[1] in 16..31))
            "$scheme://${host}${if (uri.port == -1) "" else ":${uri.port}"}/${uri.rawQuery?.let { "?$it" }.orEmpty()}"
        }.getOrNull()

        private fun ipv4(host: String): List<Int>? {
            val parts = host.split('.')
            if (parts.size != 4 || parts.any { !it.matches(Regex("0|[1-9][0-9]{0,2}")) }) return null
            return parts.map { it.toInt() }.takeIf { it.all { n -> n in 0..255 } }
        }

        fun sameOrigin(url: String?, target: String?): Boolean = runCatching {
            if (url == null || target == null) return false
            val a = URI(url); val b = URI(target)
            fun port(u: URI) = if (u.port == -1) (if (u.scheme == "https") 443 else 80) else u.port
            a.scheme == b.scheme && a.host == b.host && a.rawUserInfo == null && port(a) == port(b)
        }.getOrDefault(false)
    }
}
