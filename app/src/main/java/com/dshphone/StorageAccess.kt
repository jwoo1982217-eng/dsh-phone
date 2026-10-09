package com.dshphone

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.widget.Toast

/** User-initiated shared-file access; private app data stays in filesDir. */
object StorageAccess {
    const val REQUEST_CODE = 2701

    fun granted(activity: Activity): Boolean = if (Build.VERSION.SDK_INT >= 30) {
        Environment.isExternalStorageManager()
    } else {
        activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    }

    fun show(activity: Activity) {
        val allowed = granted(activity)
        AlertDialog.Builder(activity)
            .setTitle(if (allowed) "手机文件访问已授权" else "允许访问手机文件")
            .setMessage("授权后，聊天的“添加工作区”可以选择手机存储、下载、文档和其他共享文件夹，AI 的文件工具按会话权限读写所选工作区。其他应用的私有目录仍由安卓保护。账号和聊天记录继续保存在 DSH 内部。")
            .setPositiveButton(if (allowed) "管理权限" else "去授权") { _, _ ->
                if (Build.VERSION.SDK_INT >= 30) {
                    val ownSettings = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        Uri.parse("package:${activity.packageName}"))
                    try { activity.startActivity(ownSettings) }
                    catch (_: android.content.ActivityNotFoundException) {
                        try { activity.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
                        catch (_: android.content.ActivityNotFoundException) {
                            Toast.makeText(activity, "请在系统设置中打开 DSH 的所有文件访问权限", Toast.LENGTH_LONG).show()
                        }
                    }
                } else {
                    activity.requestPermissions(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE,
                        Manifest.permission.WRITE_EXTERNAL_STORAGE), REQUEST_CODE)
                }
            }
            .setNegativeButton("返回", null)
            .show()
    }
}
