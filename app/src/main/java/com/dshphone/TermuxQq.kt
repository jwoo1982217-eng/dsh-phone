package com.dshphone

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.widget.Toast

/** Explicit, user-initiated bridge to the official Termux execution interface. */
object TermuxQq {
    const val PERMISSION = "com.termux.permission.RUN_COMMAND"
    fun isInstalled(activity: Activity): Boolean = runCatching {
        activity.packageManager.getPackageInfo("com.termux", 0); true
    }.getOrDefault(false)

    fun openEnvironment(activity: Activity) {
        val launch = activity.packageManager.getLaunchIntentForPackage("com.termux")
        if (launch != null) activity.startActivity(launch)
        else AlertDialog.Builder(activity).setTitle("安装手机运行环境")
            .setMessage("先安装官方 Termux 并打开一次，等待初始化完成，再回到 DSH。这里运行的 QQ 登录端都在手机上。")
            .setPositiveButton("打开官方下载页") { _, _ -> activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/termux/termux-app/releases/latest"))) }
            .setNegativeButton("稍后", null).show()
    }

    fun showAuthorization(activity: Activity) {
        AlertDialog.Builder(activity).setTitle("首次授权手机运行环境")
            .setMessage("允许 DSH 安装和启动手机 QQ 登录端。\n\n点击下面按钮后，会复制一条授权命令并打开 Termux。长按空白处选择粘贴，再按键盘回车，然后返回 DSH。只需操作一次；运行环境权限可在 Termux 设置中撤销。")
            .setPositiveButton("复制授权命令并打开") { _, _ ->
                val command = "mkdir -p ~/.termux && printf '\\nallow-external-apps=true\\n' >> ~/.termux/termux.properties && termux-reload-settings"
                val clipboard = activity.getSystemService(Activity.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("DSH 手机 QQ 环境授权", command))
                openEnvironment(activity)
            }.setNegativeButton("稍后", null).show()
    }

    fun install(activity: Activity, nonce: String) {
        if (!nonce.matches(Regex("[a-f0-9]{64}"))) return
        val script = "mkdir -p ~/.cache/dsh-phone && (command -v curl >/dev/null 2>&1 || (pkg update -y && pkg install -y curl)) && curl --fail --location --retry 2 http://127.0.0.1:3080/phone-qq-setup/script/$nonce.sh -o ~/.cache/dsh-phone/install.sh && bash ~/.cache/dsh-phone/install.sh"
        val command = Intent("com.termux.RUN_COMMAND").setClassName("com.termux", "com.termux.app.RunCommandService")
            .putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash")
            .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-lc", script))
            .putExtra("com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home")
            .putExtra("com.termux.RUN_COMMAND_BACKGROUND", false)
            .putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0")
            .putExtra("com.termux.RUN_COMMAND_COMMAND_LABEL", "安装手机 QQ 登录端")
        runCatching { activity.startService(command); openEnvironment(activity) }
            .onFailure { Toast.makeText(activity, "手机运行环境未授权或未初始化，请先完成第一步授权。", Toast.LENGTH_LONG).show() }
    }

    fun restart(activity: Activity) {
        val script = "umask 077; mkdir -p ~/.cache/dsh-phone && curl --fail --location http://127.0.0.1:3080/phone-qq-setup/restart -o ~/.cache/dsh-phone/restart.sh && bash ~/.cache/dsh-phone/restart.sh"
        val command = Intent("com.termux.RUN_COMMAND").setClassName("com.termux", "com.termux.app.RunCommandService")
            .putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash")
            .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-lc", script))
            .putExtra("com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home")
            .putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
            .putExtra("com.termux.RUN_COMMAND_COMMAND_LABEL", "启动手机 QQ 登录端")
        runCatching { activity.startService(command) }
            .onSuccess { Toast.makeText(activity, "正在启动 QQ 登录端，请稍候查看二维码", Toast.LENGTH_LONG).show() }
            .onFailure { Toast.makeText(activity, "请先完成手机运行环境授权", Toast.LENGTH_LONG).show() }
    }
}
