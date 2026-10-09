package com.dshphone.control

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/** Human-only approval UI: deliberately inaccessible to phone-control tools. */
class ControlActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var body: LinearLayout
    private var previous = ""
    private var countdown: TextView? = null
    private val refresh = object : Runnable {
        override fun run() { render(); handler.postDelayed(this, 1000) }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (android.os.Build.VERSION.SDK_INT >= 31) window.setHideOverlayWindows(true)
        ControlRuntime.attach(this)
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(28, 24, 28, 24); filterTouchesWhenObscured = true }
        setContentView(ScrollView(this).apply { addView(body) })
    }
    override fun onResume() { super.onResume(); previous = ""; refresh.run() }
    override fun onPause() { handler.removeCallbacks(refresh); super.onPause() }
    private fun text(value: String, size: Float = 16f) { body.addView(TextView(this).apply { text = value; textSize = size; setPadding(0, 10, 0, 10) }) }
    private fun button(label: String, action: () -> Unit) {
        body.addView(android.widget.Button(this).apply { text = label; filterTouchesWhenObscured = true; setOnClickListener {
            runCatching(action).onFailure { Toast.makeText(this@ControlActivity, it.message ?: "操作失败", Toast.LENGTH_LONG).show() }
            previous = ""; render()
        } })
    }
    private fun render() {
        val state = ControlRuntime.status()
        val grant = state.optJSONObject("grant")
        val remaining = grant?.optLong("remainingSeconds") ?: 0
        countdown?.text = "剩余 $remaining 秒"
        val comparison = org.json.JSONObject(state.toString())
        comparison.optJSONObject("grant")?.remove("remainingSeconds")
        val serialized = comparison.toString()
        if (serialized == previous) return
        previous = serialized; body.removeAllViews(); countdown = null
        text("手机操作", 24f)
        text("手机工具直接使用聊天已有的三种权限：仅可查看、工作区内修改、完全权限，无需额外批准开关。完全权限可操作本机 App 和已授权的 Termux；仅可查看和工作区模式可读当前界面、截图和日志，工作区文件修改使用现有文件工具。截图、日志和命令结果会进入所选模型会话。")
        text(if (state.getBoolean("accessibilityConnected")) "系统无障碍已连接" else "系统无障碍未开启：需要本人在系统设置允许 DSH 完全访问")
        button("打开系统无障碍设置") { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        text("权限在聊天现有选择器切换，本页只处理 Android 必要权限。屏幕停止按钮会暂停操作，直到你发送新的指令或切换权限；已发送或已交给 Termux 的操作不会自动撤销。")
        text("App 运行日志", 20f)
        val logs = state.getJSONObject("logs")
        text(if (logs.getBoolean("available")) "日志读取已授权：可让 DSH 按 App 查看最近日志。" else logs.getString("hint"))
        button("打开 Shizuku") { AppLogs.openSetup(this) }
        if (logs.getBoolean("running") && !logs.getBoolean("permissionGranted")) button("授权日志读取") { AppLogs.requestPermission(this) }
        text("Termux / MT / Reqable", 20f)
        val termux = state.getJSONObject("termux"); text(termux.getString("hint"))
        if (termux.getBoolean("installed") && !termux.getBoolean("permissionGranted")) button("授权 Termux 命令") { requestPermissions(arrayOf(TermuxCommands.PERMISSION), 9913) }
        button("Termux 首次接入设置") { TermuxCommands.openSetup(this) }
        text("MT 管理器和 Reqable 可让 DSH 从 App 列表选择后操作界面、截图和长按。Termux 命令通过官方接口取回输出与退出码；首次需要开启外部调用。停止后，已交给 Termux 的命令可能仍在运行，必要时在 Termux 终止。")
        if (grant != null) {
            val mode = grant.optString("policyMode")
            if (mode in setOf("read-only", "workspace-write", "danger-full-access")) text("当前手机会话权限：" + when (mode) { "read-only" -> "仅可查看"; "workspace-write" -> "工作区内修改"; else -> "完全权限" })
            else text("外部已授权任务：${grant.getString("task")}\nApp：${grant.getJSONArray("packages")}")
            if (!grant.optBoolean("continuous")) { countdown = TextView(this).apply { text = "剩余 $remaining 秒" }; body.addView(countdown) }
            button("立即停止并撤回授权") { ControlRuntime.stop("用户撤回授权") }
        } else text(if (state.getBoolean("paused")) "手机操作已暂停；发送新的指令或切换权限后继续。" else "就绪：在聊天里使用现有权限选择器即可。")
        val request = state.optJSONObject("request")
        if (request != null) {
            text("待确认任务：${request.getString("task")}\n会话：${request.getString("owner")}\n时长：${request.getInt("minutes")} 分钟")
            val rows = state.getJSONArray("apps"); val names = (0 until rows.length()).associate { rows.getJSONObject(it).getString("package") to rows.getJSONObject(it).getString("name") }
            val packages = request.getJSONArray("packages"); text("仅允许：" + (0 until packages.length()).joinToString("、") { names[packages.getString(it)] ?: packages.getString(it) })
            button("允许本次任务") {
                AlertDialog.Builder(this).setTitle("允许操作指定 App？").setMessage("任务：${request.getString("task")}\n仅限上列 App 和本次时长。普通导航和文本填写可自动执行；敏感或用途不明的按钮、坐标手势需再确认。屏幕上会显示停止按钮。")
                    .setPositiveButton("允许") { _, _ -> runCatching { ControlRuntime.approve(request.getString("id")); previous = ""; render() }.onFailure { Toast.makeText(this, it.message, Toast.LENGTH_LONG).show() } }
                    .setNegativeButton("取消", null).show().apply { window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE) }
            }
            button("拒绝并关闭操作") { ControlRuntime.stop("用户拒绝申请") }
        }
        state.optJSONObject("confirmation")?.let { confirmation ->
            text("动作待确认：${confirmation.getString("label")}\nApp：${confirmation.getString("package")}\n确认后返回目标 App，告诉 AI 已确认；AI 重新读取界面再执行相同动作。")
            button("确认这个动作一次") { ControlRuntime.approveAction(confirmation.getString("id")) }
            button("拒绝动作并停止") { ControlRuntime.stop("用户拒绝动作") }
        }
        button("返回 DSH") { finish() }
    }
}
