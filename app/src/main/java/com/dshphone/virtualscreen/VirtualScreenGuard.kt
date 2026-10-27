package com.dshphone.virtualscreen

import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.dshphone.control.ControlRuntime

/** Image-coordinate automation cannot establish that an unknown/password/system window is safe. */
object VirtualScreenGuard {
    fun check(id: Int,owner: String? = null): String {
        val proof = StringBuilder()
        VirtualScreenPolicy.requireOwned("virtual-1",id)
        check(Build.VERSION.SDK_INT >= 30) { "当前系统缺少独立屏幕窗口识别能力，请在工作台由本人操作" }
        val service = ControlRuntime.service ?: error("虚拟屏 AI 坐标操作需要已启用的无障碍窗口识别；请先由本人完成设置")
        val windows = service.windowsOnAllDisplays.get(id).orEmpty().filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION || it.isActive || it.isFocused }
        check(windows.isNotEmpty()) { "无法确认虚拟屏上的 App 窗口，请查看工作台，不会回退真实屏" }
        for (window in windows) {
            val root = window.root ?: error("虚拟屏窗口内容暂不可识别，请由本人操作")
            try {
                val pkg = root.packageName?.toString().orEmpty()
                if (owner != null) ControlRuntime.lease.check(owner,pkg)
                proof.append(window.id).append(':').append(pkg).append('|')
                check(pkg.isNotBlank() && !ControlRuntime.blocked(pkg)) { "系统授权或受保护窗口只能由本人操作" }
                val queue = java.util.ArrayDeque<AccessibilityNodeInfo>(); queue.add(root)
                var count = 0
                try {
                    while (queue.isNotEmpty()) {
                        val node = queue.removeFirst()
                        try {
                            check(++count <= 500) { "虚拟屏界面过于复杂，无法确认密码输入边界" }
                            check(!(node.isVisibleToUser && node.isPassword)) { "密码窗口需要本人操作" }
                            if (node.isVisibleToUser) {
                                val bounds = android.graphics.Rect(); node.getBoundsInScreen(bounds)
                                proof.append(node.viewIdResourceName).append(':').append(node.className).append(':')
                                    .append(node.text?.toString()?.take(300)).append(':').append(node.contentDescription?.toString()?.take(200))
                                    .append(':').append(bounds.toShortString()).append(':').append(node.isEnabled).append(':').append(node.isFocused).append('|')
                            }
                            for (index in 0 until node.childCount) node.getChild(index)?.let { queue.add(it) }
                        } finally { if (node !== root) node.recycle() }
                    }
                } finally { while (queue.isNotEmpty()) queue.removeFirst().recycle() }
            } finally { root.recycle() }
        }
        return java.security.MessageDigest.getInstance("SHA-256").digest(proof.toString().toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
