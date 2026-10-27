package com.dshphone.control

import android.content.ComponentName
import android.content.Context
import android.os.Binder
import android.os.Parcel
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Fixed own-app repair behind the user's existing Shizuku grant. No shell or target arguments. */
class ControlRepairService(context: Context) : Binder() {
    private val clientUid = context.applicationInfo.uid
    private val packageName = context.packageName
    init { attachInterface(null, DESCRIPTOR) }
    override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        if (code == INTERFACE_TRANSACTION) { reply?.writeString(DESCRIPTOR); return true }
        if (code == 16777115) kotlin.system.exitProcess(0)
        if (code != REPAIR && code != RECONNECT) return super.onTransact(code, data, reply, flags)
        check(getCallingUid() == clientUid) { "只允许本应用恢复自己的控制通道" }
        data.enforceInterface(DESCRIPTOR)
        require(data.dataAvail() == 0) { "恢复请求不能指定其他应用、命令或参数" }
        val own = "$packageName/com.dshphone.control.PhoneControlService"
        val previous = command("settings", "get", "secure", "enabled_accessibility_services").trim()
        if (code == RECONNECT && !containsService(previous, own)) {
            val state = command("cmd", "appops", "get", packageName, "ACCESS_RESTRICTED_SETTINGS")
            check(Regex("ACCESS_RESTRICTED_SETTINGS: (ignore|deny|errored)").containsMatchIn(state)) {
                "DSH 无障碍已被关闭，不自动覆盖关闭操作；请在服务→手机操作点“开启并检查”恢复"
            }
        }
        // Same operation as allowing restricted settings for this app; never changes device-wide policy.
        command("cmd", "appops", "set", packageName, "ACCESS_RESTRICTED_SETTINGS", "allow")
        val latest = command("settings", "get", "secure", "enabled_accessibility_services").trim()
        // If it was enabled but disconnected, rebind only our service; retain all other components.
        if (containsService(latest, own)) {
            val others = latest.split(':').filter { it.isNotBlank() && it != "null" && ComponentName.unflattenFromString(it) != ComponentName.unflattenFromString(own) }
            command("settings", "put", "secure", "enabled_accessibility_services", others.joinToString(":"))
        }
        val current = command("settings", "get", "secure", "enabled_accessibility_services").trim()
        val merged = mergeServices(current, own)
        if (merged != current) command("settings", "put", "secure", "enabled_accessibility_services", merged)
        command("settings", "put", "secure", "accessibility_enabled", "1")
        val after = command("settings", "get", "secure", "enabled_accessibility_services").trim()
        val oldServices = previous.split(':').filter { it.isNotBlank() && it != "null" }
        check(oldServices.all { it in after.split(':') }) { "系统无障碍配置发生并发变化，请在系统设置核对；不覆盖其他应用设置" }
        check(containsService(after, own)) { "系统没有接受 DSH 无障碍设置，请在系统设置开启" }
        reply!!.writeNoException()
        reply.writeString(JSONObject().put("settingsAccepted", true).put("otherServicesPreserved", true).toString())
        return true
    }
    private fun command(vararg args: String): String {
        val process = ProcessBuilder(*args).redirectErrorStream(true).start()
        try {
            check(process.waitFor(4, TimeUnit.SECONDS)) { "系统设置操作超时，请返回检查当前状态" }
            val output = process.inputStream.bufferedReader().readText().take(8192)
            check(process.exitValue() == 0 && !output.contains("Exception") && !output.startsWith("Error:")) { "系统拒绝自动恢复，请按页面提示处理" }
            return output
        } finally { process.destroy() }
    }
    companion object {
        const val DESCRIPTOR = "com.dshphone.control.ControlRepairService"
        const val REPAIR = FIRST_CALL_TRANSACTION
        const val RECONNECT = FIRST_CALL_TRANSACTION + 1
        private fun containsService(value: String, own: String): Boolean = value.split(':').any { ComponentName.unflattenFromString(it) == ComponentName.unflattenFromString(own) }
        internal fun mergeServices(value: String, own: String): String {
            require(ComponentName.unflattenFromString(own) != null)
            val services = value.split(':').filter { it.isNotBlank() && it != "null" }
            return if (containsService(value, own)) services.joinToString(":") else (services + own).joinToString(":")
        }
    }
}
