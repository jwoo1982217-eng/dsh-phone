package com.dshphone.terminal

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputFilter
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.atomic.AtomicBoolean

/** Native UI, no WebView/JS bridge and no command data accepted from external intents. */
open class TerminalActivity : Activity() {
    private lateinit var session: ShellSession
    private lateinit var statusView: TextView
    private lateinit var outputView: TextView
    private lateinit var inputView: EditText
    private lateinit var sendButton: Button
    private lateinit var stopButton: Button
    private lateinit var reconnectButton: Button
    private val handler = Handler(Looper.getMainLooper())
    private val pendingRender = AtomicBoolean(false)
    @Volatile private var destroyed = false
    protected open fun createSession() = ShellSession(AndroidShellFactory(applicationContext))
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        val root = LinearLayout(this).apply {
            orientation=LinearLayout.VERTICAL; setPadding(dp(12),dp(12),dp(12),dp(8))
            setBackgroundColor(Color.rgb(20,24,29)); fitsSystemWindows=true
        }
        root.addView(TextView(this).apply { text="独立终端"; textSize=22f; setTextColor(Color.WHITE) })
        root.addView(TextView(this).apply {
            id=INFO_ID; text="非 PTY · 按行执行，不支持 vim/top 等全屏交互。使用应用已有权限；关闭或旋转页面会停止命令。";
            textSize=12f; setTextColor(Color.LTGRAY)
        })
        statusView=TextView(this).apply { setTextColor(Color.rgb(128,210,190)); textSize=13f }
        root.addView(statusView)
        val controls=LinearLayout(this).apply { orientation=LinearLayout.HORIZONTAL; gravity=Gravity.CENTER_VERTICAL }
        reconnectButton=button("重连") { session.start() }; controls.addView(reconnectButton,weighted())
        stopButton=button("停止") { session.stop() }; controls.addView(stopButton,weighted())
        controls.addView(button("清屏") { session.clearOutput() },weighted())
        controls.addView(button("复制") {
            (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(
                ClipData.newPlainText("DSH 终端输出",session.snapshot().output))
            Toast.makeText(this,"已复制当前输出",Toast.LENGTH_SHORT).show()
        },weighted())
        root.addView(controls)
        outputView=TextView(this).apply {
            textSize=13f; typeface=Typeface.MONOSPACE; setTextColor(Color.rgb(222,229,235)); setTextIsSelectable(true)
            setPadding(dp(4),dp(4),dp(4),dp(4))
        }
        val scroll=ScrollView(this).apply { isFillViewport=true; addView(outputView) }
        root.addView(scroll,LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,0,1f))
        val commandRow=LinearLayout(this).apply { orientation=LinearLayout.HORIZONTAL; gravity=Gravity.CENTER_VERTICAL }
        inputView=EditText(this).apply {
            id=INPUT_ID; hint="输入 Bash 命令"; setTextColor(Color.WHITE); setHintTextColor(Color.GRAY)
            typeface=Typeface.MONOSPACE; textSize=14f; minLines=1; maxLines=4
            inputType=android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            filters=arrayOf(InputFilter.LengthFilter(8192)); importantForAutofill=android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        }
        commandRow.addView(inputView,LinearLayout.LayoutParams(0,ViewGroup.LayoutParams.WRAP_CONTENT,1f))
        sendButton=button("执行") {
            val command=inputView.text.toString()
            if (session.submit(command)) inputView.setText("") else
                Toast.makeText(this,"未执行：请检查连接、输入长度或稍后重试",Toast.LENGTH_SHORT).show()
        }.apply { id=SEND_ID; isEnabled=false }
        commandRow.addView(sendButton); root.addView(commandRow)
        setContentView(root)
        session=createSession()
        session.setListener { requestRender() }
        session.start()
    }
    private fun requestRender() {
        if (destroyed || !pendingRender.compareAndSet(false,true)) return
        // Coalesce output floods into one bounded UI update; do not queue every read chunk.
        handler.postDelayed({
            pendingRender.set(false)
            if (!destroyed) {
                val snapshot=session.snapshot()
                statusView.text=snapshot.status
                outputView.text=snapshot.output
                sendButton.isEnabled=snapshot.state==ShellSession.State.READY
                inputView.isEnabled=sendButton.isEnabled
                stopButton.isEnabled=snapshot.state==ShellSession.State.READY || snapshot.state==ShellSession.State.STARTING
                reconnectButton.isEnabled=snapshot.state !in listOf(ShellSession.State.STARTING,ShellSession.State.STOPPING,ShellSession.State.CLOSED)
            }
        },40)
    }
    private fun button(label: String, action: () -> Unit) = Button(this).apply {
        text=label; textSize=12f; minWidth=0; setPadding(dp(4),0,dp(4),0); setOnClickListener { action() }
    }
    private fun weighted() = LinearLayout.LayoutParams(0,ViewGroup.LayoutParams.WRAP_CONTENT,1f)
    private fun dp(value: Int) = (value*resources.displayMetrics.density).toInt()
    override fun onDestroy() {
        destroyed=true
        handler.removeCallbacksAndMessages(null)
        if (::session.isInitialized) { session.setListener(null); session.close() }
        super.onDestroy()
    }
    companion object {
        const val INPUT_ID=0x00d50101
        const val SEND_ID=0x00d50102
        const val INFO_ID=0x00d50103
    }
}
