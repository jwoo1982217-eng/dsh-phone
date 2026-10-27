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
    private var setupActive = false
    private var repairing = false
    private var setupMessage = ""
    private val attempted = mutableSetOf<ControlSetup.Step>()
    private val refresh = object : Runnable {
        override fun run() { render(); if (setupActive && !repairing) advanceSetup(false); handler.postDelayed(this, 1000) }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (android.os.Build.VERSION.SDK_INT >= 31) window.setHideOverlayWindows(true)
        ControlRuntime.attach(this)
        setupActive = savedInstanceState?.getBoolean("setupActive") ?: false
        savedInstanceState?.getStringArrayList("attempted")?.forEach { name -> runCatching { attempted.add(ControlSetup.Step.valueOf(name)) } }
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(28, 24, 28, 24); filterTouchesWhenObscured = true }
        setContentView(ScrollView(this).apply { addView(body) })
    }
    override fun onResume() { super.onResume(); previous = ""; refresh.run() }
    override fun onPause() { handler.removeCallbacks(refresh); super.onPause() }
    override fun onSaveInstanceState(out: Bundle) {
        out.putBoolean("setupActive", setupActive && !repairing)
        out.putStringArrayList("attempted", ArrayList(attempted.map { it.name }))
        super.onSaveInstanceState(out)
    }
    private fun advanceSetup(manual: Boolean) {
        if (repairing) return
        if (manual) { ControlRepair.enableAutomatic(this); setupActive = true; attempted.clear(); setupMessage = "正在检查已有授权…" }
        if (!setupActive) return
        val state = ControlRuntime.status()
        val step = ControlSetup.next(state, ControlSetup.installed(this), ControlSetup.restricted(this))
        if (!attempted.add(step)) return
        when (step) {
            ControlSetup.Step.DONE -> { setupActive = false; setupMessage = "检查完成。已有授权会直接复用，回聊天即可使用；未安装的可选工具不影响已就绪功能。" }
            ControlSetup.Step.REPAIR_ACCESSIBILITY -> {
                repairing = true; setupMessage = "正在使用已授予的 Shizuku 权限恢复 DSH 无障碍，不更改其他应用开关…"
                try {
                    ControlRepair.run(applicationContext).whenComplete { _, error -> handler.post {
                        repairing = false
                        if (isFinishing || isDestroyed) return@post
                        if (error != null) {
                            setupActive = false
                            setupMessage = "系统未能自动恢复。请打开应用信息，右上角菜单→允许受限设置，再打开系统无障碍设置→DSH 手机操作。返回此页会显示实际连接状态。"
                        } else setupMessage = "系统已接受 DSH 无障碍设置，正在等待连接；已授权的日志和命令通道继续可用。"
                        previous = ""; render()
                    } }
                } catch (_: Throwable) {
                    repairing = false; setupActive = false; setupMessage = "Shizuku 连接已变化，请检查下方日志通道后重试。"
                }
            }
            ControlSetup.Step.APP_INFO -> {
                setupMessage = "系统限制了 DSH：在应用信息右上角菜单选择“允许受限设置”，然后返回，继续开启 DSH 手机操作。"
                startActivity(ControlSetup.appInfo(this))
            }
            ControlSetup.Step.ACCESSIBILITY -> {
                setupMessage = "在系统无障碍页面开启“DSH 手机操作”。如果该项为灰色或显示“由受限设置控制”，先打开应用信息→右上角菜单→允许受限设置。"
                startActivity(ControlSetup.accessibility())
            }
            ControlSetup.Step.START_SHIZUKU -> {
                setupMessage = "先在 Shizuku 启动服务；已有配对可直接启动，首次按其配对引导操作。返回后会自动复查，已就绪的界面控制和 Termux 不受影响。"
                AppLogs.openSetup(this)
            }
            ControlSetup.Step.SHIZUKU_PERMISSION -> { setupMessage = "只需允许这次 Android Shizuku 授权，之后自动复用。"; AppLogs.requestPermission(this) }
            ControlSetup.Step.TERMUX_PERMISSION -> { setupMessage = "只需允许这次 Android Termux 命令权限，之后自动复用。"; requestPermissions(arrayOf(TermuxCommands.PERMISSION), 9913) }
        }
        previous = ""; render()
    }
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
        comparison.put("setupMessage", setupMessage).put("repairing", repairing)
        comparison.optJSONObject("grant")?.remove("remainingSeconds")
        val serialized = comparison.toString()
        if (serialized == previous) return
        previous = serialized; body.removeAllViews(); countdown = null
        text("手机控制", 24f)
        text("沿用聊天已有的权限。“完全权限”下直接操作应用和执行已接入的命令，无需逐项批准。开启并检查会复用已有授权，缺哪一项就处理哪一项。截图、日志和命令结果会进入所选模型会话。")
        button("开启并检查") { advanceSetup(true) }
        if (setupMessage.isNotBlank()) text(setupMessage)
        text("界面控制", 20f)
        text(if (state.getBoolean("accessibilityConnected")) "已就绪：可以查看、点击、输入和切换应用。" else if (ControlSetup.restricted(this) == true) "系统限制了 DSH 无障碍。点击上方按钮可用已授权的 Shizuku 尝试恢复；没有该授权时引导到应用信息允许受限设置。" else "未连接：点击上方按钮检查并恢复。系统显示“由受限设置控制”时，先在 DSH 应用信息右上角允许受限设置。")
        button("打开系统无障碍设置") { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        button("打开应用信息（允许受限设置）") { startActivity(ControlSetup.appInfo(this)) }
        text("App 运行日志", 20f)
        val logs = state.getJSONObject("logs")
        text(if (logs.getBoolean("available")) "日志读取已授权：可让 DSH 按 App 查看最近日志。" else logs.getString("hint"))
        button("打开 Shizuku") { AppLogs.openSetup(this) }
        if (logs.getBoolean("running") && !logs.getBoolean("permissionGranted")) button("授权日志读取") { AppLogs.requestPermission(this) }
        text("Termux 命令", 20f)
        val termux = state.getJSONObject("termux"); text(termux.getString("hint"))
        if (termux.getBoolean("installed") && !termux.getBoolean("permissionGranted")) button("授权 Termux 命令") { requestPermissions(arrayOf(TermuxCommands.PERMISSION), 9913) }
        button("Termux 首次接入设置") { TermuxCommands.openSetup(this) }
        text("三个通道分别工作，日志或命令未就绪不会挡住已连接的界面控制。停止按钮会暂停后续操作，新指令可继续；已提交的命令不会自动撤销。")
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
