package com.dshphone.control

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** One bounded tree; references live only during a main-thread operation. */
class ControlScreen(private val root: AccessibilityNodeInfo) : AutoCloseable {
    val packageName = root.packageName?.toString().orEmpty()
    val windowId = root.windowId
    val nodes = linkedMapOf<String, AccessibilityNodeInfo>()
    private val rows = JSONArray()
    var truncated = false; private set
    init { visit(root, 0) }
    private fun visit(node: AccessibilityNodeInfo, depth: Int) {
        if (nodes.size >= 256 || depth > 30) { truncated = true; node.recycle(); return }
        val id = "n${nodes.size}"; nodes[id] = node
        val bounds = Rect(); node.getBoundsInScreen(bounds)
        val password = node.isPassword
        rows.put(JSONObject().put("id", id).put("text", if (password) "[密码已隐藏]" else node.text?.toString().orEmpty().take(300))
            .put("description", if (password) "" else node.contentDescription?.toString().orEmpty().take(200))
            .put("viewId", node.viewIdResourceName.orEmpty()).put("class", node.className?.toString().orEmpty())
            .put("bounds", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom)))
            .put("clickable", node.isClickable).put("longClickable", node.isLongClickable).put("editable", node.isEditable).put("scrollable", node.isScrollable)
            .put("enabled", node.isEnabled).put("visible", node.isVisibleToUser).put("password", password))
        for (i in 0 until node.childCount) {
            if (nodes.size >= 256) { truncated = true; break }
            node.getChild(i)?.let { visit(it, depth + 1) }
        }
    }
    fun json() = JSONObject().put("package", packageName).put("windowId", windowId).put("nodes", rows).put("truncated", truncated)
    fun fingerprint(): String = MessageDigest.getInstance("SHA-256").digest(json().toString().toByteArray()).joinToString("") { "%02x".format(it) }
    fun label(id: String): String {
        val node = nodes[id] ?: error("界面元素不存在，请重新读取")
        if (node.isPassword) return "密码输入框"
        // Include immediate children for icon/button containers; never read password text.
        val labels = mutableListOf(node.text?.toString().orEmpty(), node.contentDescription?.toString().orEmpty())
        for (i in 0 until minOf(node.childCount, 8)) node.getChild(i)?.let { child ->
            try { if (!child.isPassword) { labels.add(child.text?.toString().orEmpty()); labels.add(child.contentDescription?.toString().orEmpty()) } }
            finally { child.recycle() }
        }
        return labels.joinToString(" ").trim().take(500)
    }
    override fun close() { nodes.values.forEach { it.recycle() }; nodes.clear() }
}
