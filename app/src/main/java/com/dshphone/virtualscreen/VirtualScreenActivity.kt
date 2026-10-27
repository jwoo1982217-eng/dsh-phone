package com.dshphone.virtualscreen

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.HorizontalScrollView
import android.widget.TextView
import android.widget.Toast
import com.dshphone.control.AppLogs
import org.json.JSONObject

/** Human viewer only; third-party virtual display content has no WebView or JavaScript bridge. */
class VirtualScreenActivity : Activity(), SurfaceHolder.Callback {
    private lateinit var stage: FrameLayout
    private lateinit var surface: SurfaceView
    private lateinit var status: TextView
    private var busy = false
    private var down: Pair<Float,Float>? = null
    private var downAt = 0L
    private var visible = false
    private val updates = android.os.Handler(android.os.Looper.getMainLooper())
    private val rotationPoll = object : Runnable {
        override fun run() { if (visible) { refresh(); updates.postDelayed(this,1000) } }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (12*resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad,pad,pad,pad) }
        root.addView(TextView(this).apply { text = "虚拟屏工作台 / Virtual screen"; textSize = 20f })
        root.addView(TextView(this).apply { text = "第三方 App 在 virtual-1 独立运行，不会转到真实屏。需要本人启动并授权 Shizuku；部分系统不允许跨屏启动。空闲10分钟回收。"; textSize = 13f })
        status = TextView(this); root.addView(status)
        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        fun button(label: String, action: () -> Unit) = Button(this).apply { text = label; setOnClickListener { action() } }
        controls.addView(button("Shizuku") { if (VirtualDisplayTransport.available()) note("Shizuku 已授权") else runCatching { VirtualDisplayTransport.requestPermission() }.onFailure { AppLogs.openSetup(this) } })
        controls.addView(button("创建") {
            if (busy) return@button
            AlertDialog.Builder(this).setTitle("选择虚拟屏尺寸").setItems(arrayOf("竖屏 480×800","横屏 800×480","竖屏 720×1280")) { _, which ->
                val sizes = arrayOf(480 to 800,800 to 480,720 to 1280); val size = sizes[which]
                command(JSONObject().put("action","create").put("width",size.first).put("height",size.second))
            }.setNegativeButton("取消",null).show()
        })
        controls.addView(button("打开 App") { chooseApp() })
        root.addView(HorizontalScrollView(this).apply { addView(controls) },LinearLayout.LayoutParams(-1,-2))
        val navigation = LinearLayout(this)
        navigation.addView(button("返回 / Back") { command(JSONObject().put("action","back")) })
        navigation.addView(button("关闭虚拟屏") {
            AlertDialog.Builder(this).setTitle("关闭虚拟屏？").setMessage("将结束该虚拟屏上的任务，不移动到真实屏；不会清除 App 数据。")
                .setPositiveButton("关闭") { _, _ -> command(JSONObject().put("action","destroy")) }.setNegativeButton("取消",null).show()
        })
        root.addView(navigation)
        stage = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        surface = SurfaceView(this); surface.holder.addCallback(this); stage.addView(surface,FrameLayout.LayoutParams(1,1,Gravity.CENTER))
        root.addView(stage,LinearLayout.LayoutParams(-1,0,1f)); setContentView(root)
        stage.addOnLayoutChangeListener { _,_,_,_,_,_,_,_,_ -> fit() }
        surface.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> { down = event.x to event.y; downAt = event.eventTime; true }
                MotionEvent.ACTION_CANCEL -> { down = null; true }
                MotionEvent.ACTION_UP -> {
                    val start = down; down = null
                    val size = VirtualScreenController.dimensions()
                    if (start != null && size != null && !busy) runCatching {
                        val first = VirtualScreenPolicy.point(start.first.toDouble(),start.second.toDouble(),surface.width,surface.height,size.first,size.second)
                        val last = VirtualScreenPolicy.point(event.x.toDouble(),event.y.toDouble(),surface.width,surface.height,size.first,size.second)
                        val swipe = kotlin.math.abs(last[0]-first[0])+kotlin.math.abs(last[1]-first[1])>16
                        val args = JSONObject().put("action",if (swipe) "swipe" else "tap").put("x",first[0]).put("y",first[1])
                        if (swipe) args.put("endX",last[0]).put("endY",last[1]).put("duration",(event.eventTime-downAt).coerceIn(50,2000))
                        command(args)
                    }.onFailure { note(it.message.orEmpty()) }
                    true
                }
                else -> true
            }
        }
        refresh()
    }
    private fun chooseApp() {
        if (busy) return
        val rows = packageManager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER),0)
            .distinctBy { it.activityInfo.packageName }.filter { it.activityInfo.packageName != packageName && !it.activityInfo.packageName.contains("permissioncontroller") }
            .sortedBy { it.loadLabel(packageManager).toString() }
        AlertDialog.Builder(this).setTitle("在虚拟屏打开 App").setItems(rows.map { "${it.loadLabel(packageManager)} (${it.activityInfo.packageName})" }.toTypedArray()) { _, index ->
            command(JSONObject().put("action","launch").put("package",rows[index].activityInfo.packageName))
        }.setNegativeButton("取消",null).show()
    }
    private fun command(args: JSONObject) {
        if (busy) return
        busy = true; status.text = "处理中…"
        VirtualScreenController.dispatchViewer(applicationContext,args).whenComplete { value,error ->
            runOnUiThread {
                busy = false
                if (isDestroyed) return@runOnUiThread
                if (error != null) note(error.cause?.message ?: error.message ?: "虚拟屏操作失败")
                refresh()
            }
        }
    }
    private fun refresh() { status.text = VirtualScreenController.status().let { if (it.optString("status") == "active") "virtual-1 · display ${it.optInt("displayId")} · ${it.optInt("width")}×${it.optInt("height")}" else "尚未创建虚拟屏" }; fit() }
    private fun fit() {
        if (!::stage.isInitialized || stage.width <= 0 || stage.height <= 0) return
        val size = VirtualScreenController.dimensions()
        if (size == null) { surface.visibility = View.INVISIBLE; return }
        surface.visibility = View.VISIBLE
        val rect = VirtualScreenPolicy.fit(stage.width,stage.height,size.first,size.second)
        if (surface.layoutParams.width != rect[2] || surface.layoutParams.height != rect[3]) surface.layoutParams = FrameLayout.LayoutParams(rect[2],rect[3],Gravity.CENTER)
        if (surface.holder.surfaceFrame.width() != size.first || surface.holder.surfaceFrame.height() != size.second) surface.holder.setFixedSize(size.first,size.second)
        if (visible && surface.holder.surface.isValid) runCatching { VirtualScreenController.attach(surface.holder.surface) }
    }
    private fun note(text: String) { Toast.makeText(this,text,Toast.LENGTH_LONG).show() }
    override fun onStart() { super.onStart(); visible = true; updates.removeCallbacks(rotationPoll); updates.post(rotationPoll) }
    override fun onStop() { visible = false; updates.removeCallbacks(rotationPoll); VirtualScreenController.detach(surface.holder.surface); super.onStop() }
    override fun surfaceCreated(holder: SurfaceHolder) { if (visible) runCatching { VirtualScreenController.attach(holder.surface) } }
    override fun surfaceChanged(holder: SurfaceHolder,format: Int,width: Int,height: Int) { if (visible && width > 0 && height > 0) runCatching { VirtualScreenController.attach(holder.surface) } }
    override fun surfaceDestroyed(holder: SurfaceHolder) { VirtualScreenController.detach(holder.surface) }
}
