package com.dshphone.control

import android.app.AppOpsManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Process
import android.provider.Settings
import org.json.JSONObject

/** Setup changes only Android backends; it never changes or claims a session lease. */
object ControlSetup {
    fun addReadiness(state: JSONObject, ctx: Context) {
        val automatic = ControlRepair.automaticEnabled(ctx)
        val reconnect = automatic && state.getJSONObject("logs").optBoolean("available")
        state.put("automaticReconnectEnabled", automatic).put("automaticReconnectAvailable", reconnect)
        state.put("recoveryHint", if (state.optBoolean("accessibilityConnected"))
            "界面控制已就绪，直接沿用现有聊天权限；无需再次申请任务授权。"
        else if (reconnect)
            "已开启自动恢复：在现有完全权限下直接调用手机操作，提交动作前会先尝试恢复无障碍；无需再次申请聊天权限或任务批准。主动关闭的无障碍不会自动覆盖。"
        else "无障碍未连接：到服务→手机操作点“开启并检查”处理缺失的 Android 通道；聊天已有权限保持不变。")
    }
    enum class Step { REPAIR_ACCESSIBILITY, APP_INFO, ACCESSIBILITY, START_SHIZUKU, SHIZUKU_PERMISSION, TERMUX_PERMISSION, DONE }
    fun installed(ctx: Context) = runCatching { ctx.packageManager.getPackageInfo("moe.shizuku.privileged.api", 0); true }.getOrDefault(false)
    fun restricted(ctx: Context): Boolean? {
        if (Build.VERSION.SDK_INT < 33) return false
        return runCatching {
            when ((ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager)
                .unsafeCheckOpNoThrow("android:access_restricted_settings", Process.myUid(), ctx.packageName)) {
                AppOpsManager.MODE_IGNORED, AppOpsManager.MODE_ERRORED -> true
                AppOpsManager.MODE_ALLOWED -> false
                else -> null
            }
        }.getOrNull()
    }
    fun next(state: JSONObject, shizukuInstalled: Boolean, restricted: Boolean?): Step {
        val logs = state.getJSONObject("logs")
        if (!state.getBoolean("accessibilityConnected")) {
            if (logs.optBoolean("running") && logs.optBoolean("permissionGranted")) return Step.REPAIR_ACCESSIBILITY
            if (shizukuInstalled && !logs.optBoolean("running")) return Step.START_SHIZUKU
            if (logs.optBoolean("running") && !logs.optBoolean("permissionGranted")) return Step.SHIZUKU_PERMISSION
            return if (restricted == true) Step.APP_INFO else Step.ACCESSIBILITY
        }
        if (shizukuInstalled && !logs.optBoolean("running")) return Step.START_SHIZUKU
        if (logs.optBoolean("running") && !logs.optBoolean("permissionGranted")) return Step.SHIZUKU_PERMISSION
        val termux = state.getJSONObject("termux")
        if (termux.optBoolean("installed") && !termux.optBoolean("permissionGranted")) return Step.TERMUX_PERMISSION
        return Step.DONE
    }
    fun appInfo(ctx: Context) = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx.packageName))
    fun accessibility() = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
}
