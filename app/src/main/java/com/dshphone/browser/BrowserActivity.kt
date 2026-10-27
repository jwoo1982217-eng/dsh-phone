package com.dshphone.browser

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*
import org.json.JSONObject

/** Native workbench for existing owner-scoped tabs; pages never receive a native JS interface. */
class BrowserActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var stage: FrameLayout
    private lateinit var url: EditText
    private lateinit var tabs: Spinner
    private lateinit var note: TextView
    private var owner = "manual"
    private var selected: String? = null
    private var binding = false
    private var visible = false
    private var fingerprint = ""
    private val poll = object : Runnable {
        override fun run() { if (visible) { refresh(false); handler.postDelayed(this,1500) } }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        owner = intent.getStringExtra("owner")?.takeIf { it.matches(Regex("[a-zA-Z0-9_-]{1,128}")) } ?: "manual"
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        url = EditText(this).apply { hint = "HTTP/HTTPS 网页地址"; setSingleLine() }
        tabs = Spinner(this)
        val row = LinearLayout(this)
        row.addView(url,LinearLayout.LayoutParams(0,-2,1f))
        row.addView(Button(this).apply { text = "打开"; setOnClickListener { action("open",JSONObject().put("url",url.text.toString())) } })
        body.addView(row); body.addView(tabs)
        val tools = LinearLayout(this)
        fun button(label: String, run: () -> Unit) = Button(this).apply { text = label; setOnClickListener { run() } }
        for ((label,method) in listOf("后退" to "back","前进" to "forward","刷新" to "reload","关闭标签" to "close"))
            tools.addView(button(label) { action(method) })
        tools.addView(button("视口 / 身份") { chooseProfile() })
        body.addView(HorizontalScrollView(this).apply { addView(tools) })
        note = TextView(this).apply { textSize = 12f }; body.addView(note)
        stage = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        body.addView(stage,LinearLayout.LayoutParams(-1,0,1f)); setContentView(body)
        stage.addOnLayoutChangeListener { _,_,_,_,_,_,_,_,_ -> fit() }
        refresh(true)
    }
    private fun action(method: String,args: JSONObject = JSONObject()) {
        if (method != "open" && selected == null) { note.text = "请先打开网页"; return }
        if (method != "open") args.put("tabId",selected)
        BrowserClient.call(this,owner,method,args).whenComplete { _,error -> handler.post {
            if (isDestroyed) return@post
            if (error != null) Toast.makeText(this,error.cause?.message ?: error.message,Toast.LENGTH_LONG).show()
            refresh(true)
        } }
    }
    private fun chooseProfile() {
        if (selected == null) { note.text = "请先打开网页"; return }
        AlertDialog.Builder(this).setTitle("视口与网页身份").setMessage("切换会重新加载当前标签，未提交的表单可能丢失。其他标签和浏览器登录资料保留。")
            .setPositiveButton("选择配置") { _,_ ->
                AlertDialog.Builder(this).setTitle("网页视口").setItems(arrayOf("手机 412×915","平板 820×1180","桌面 1280×800","自定义…")) { _,which ->
                    val sizes = arrayOf(412 to 915,820 to 1180,1280 to 800)
                    if (which < 3) setProfile(sizes[which].first,sizes[which].second,if(which == 2) "windows-desktop" else "android-real")
                    else customProfile()
                }.setNegativeButton("取消",null).show()
            }.setNegativeButton("取消",null).show()
    }
    private fun customProfile() {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val size = BrowserService.current?.profile(owner,selected ?: "") ?: (412 to 915)
        val w = EditText(this).apply { hint = "CSS宽240–1920"; inputType = 2; setText(size.first.toString()) }
        val h = EditText(this).apply { hint = "CSS高240–2560"; inputType = 2; setText(size.second.toString()) }
        val desktop = CheckBox(this).apply { text = "桌面身份（Windows / Chromium）" }
        box.addView(w); box.addView(h); box.addView(desktop)
        val dialog = AlertDialog.Builder(this).setTitle("自定义视口").setView(box).setPositiveButton("应用",null).setNegativeButton("取消",null).create()
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            runCatching {
                val width = w.text.toString().toInt(); val height = h.text.toString().toInt()
                val identity = if(desktop.isChecked) "windows-desktop" else "android-real"
                BrowserProfilePolicy.validate(width,height,identity); dialog.dismiss(); setProfile(width,height,identity)
            }.onFailure { Toast.makeText(this,it.message ?: "请输入有效尺寸",Toast.LENGTH_LONG).show() }
        } }; dialog.show()
    }
    private fun setProfile(width: Int,height: Int,identity: String) = action("profile",JSONObject().put("viewportWidth",width).put("viewportHeight",height).put("identity",identity))
    private fun refresh(force: Boolean) {
        if (isDestroyed) return
        val service = BrowserService.current
        if (service == null) {
            if(force) BrowserClient.call(this,owner,"status",JSONObject()).whenComplete { _,error -> handler.post {
                if (isDestroyed) return@post
                if(error == null) refresh(true) else note.text = error.message
            } }
            return
        }
        val status = service.status(owner); val next = status.toString()
        if (!force && next == fingerprint) { fit(); return }
        fingerprint = next
        val rows = status.getJSONArray("tabs"); val ids = (0 until rows.length()).map { rows.getJSONObject(it).getString("id") }
        binding = true
        tabs.onItemSelectedListener = null
        tabs.adapter = ArrayAdapter(this,android.R.layout.simple_spinner_dropdown_item,(0 until rows.length()).map { rows.getJSONObject(it).optString("title").ifBlank { rows.getJSONObject(it).optString("url") } })
        selected = status.optString("active").takeIf { it in ids }
        val index = ids.indexOf(selected ?: "")
        if(index >= 0) tabs.setSelection(index,false)
        binding = false
        tabs.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) {}
            override fun onItemSelected(parent: AdapterView<*>?,view: View?,position: Int,id: Long) {
                if(binding || position !in ids.indices || selected == ids[position]) return
                service.select(owner,ids[position]); selected = ids[position]; refresh(true)
            }
        }
        val record = if(index >= 0) rows.getJSONObject(index) else null
        note.text = record?.let {
            val observed = it.optJSONObject("viewportObserved")
            "请求 ${it.optInt("viewportWidth")}×${it.optInt("viewportHeight")} · ${it.optString("effectiveIdentity")} · " +
                (if(observed == null) "实际视口待页面测量" else "实测 ${observed.optInt("width")}×${observed.optInt("height")}") +
                (if(!it.isNull("error")) "\n${it.optString("error")}" else "") + it.optString("profileNote")
        } ?: "没有标签页；网页与主会话登录环境相互隔离"
        val web = selected?.let { service.view(owner,it) }
        if (web == null) stage.removeAllViews()
        else {
            if(web.parent !== stage) { stage.removeAllViews(); (web.parent as? ViewGroup)?.removeView(web); stage.addView(web) }
            if(!url.hasFocus()) url.setText(web.url ?: "")
        }
        fit()
    }
    private fun fit() {
        val id = selected ?: return
        val size = BrowserService.current?.profile(owner,id) ?: return
        val web = BrowserService.current?.view(owner,id) ?: return
        if(stage.width <= 0 || stage.height <= 0) return
        val rect = BrowserProfilePolicy.fit(stage.width,stage.height,size.first,size.second,resources.displayMetrics.density.toDouble())
        val params = web.layoutParams
        if(params?.width != rect[2] || params.height != rect[3]) web.layoutParams = FrameLayout.LayoutParams(rect[2],rect[3],Gravity.CENTER)
    }
    override fun onStart() { super.onStart(); visible = true; handler.removeCallbacks(poll); handler.post(poll) }
    override fun onStop() { visible = false; handler.removeCallbacks(poll); super.onStop() }
    override fun onDestroy() { handler.removeCallbacks(poll); stage.removeAllViews(); super.onDestroy() }
}
