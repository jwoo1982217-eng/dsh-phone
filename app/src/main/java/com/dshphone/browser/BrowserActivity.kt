package com.dshphone.browser

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.*
import android.view.ViewGroup
import org.json.JSONObject

/** Visible view of the same tabs the Agent controls; manual tabs have their own owner. */
class BrowserActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var body: LinearLayout
    private lateinit var url: EditText
    private lateinit var tabs: Spinner
    private var owner = "manual"
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        owner = intent.getStringExtra("owner")?.takeIf { it.matches(Regex("[a-zA-Z0-9_-]{1,128}")) } ?: "manual"
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        url = EditText(this).apply { hint = "输入网页地址"; setSingleLine() }
        tabs = Spinner(this)
        val row = LinearLayout(this)
        row.addView(url, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(Button(this).apply { text = "打开"; setOnClickListener {
            BrowserClient.call(this@BrowserActivity, owner, "open", JSONObject().put("url", url.text.toString())).whenComplete { _, error -> handler.post {
                if (error != null) Toast.makeText(this@BrowserActivity, error.message, Toast.LENGTH_LONG).show()
                refresh()
            } }
        } })
        body.addView(row); body.addView(tabs)
        setContentView(body); refresh()
    }
    private fun refresh() {
        BrowserClient.call(this, owner, "status", JSONObject()).whenComplete { _, error -> handler.post {
            if (error != null) { Toast.makeText(this, error.message, Toast.LENGTH_LONG).show(); return@post }
            val service = BrowserService.current ?: return@post
            val status = service.status(owner); val rows = status.getJSONArray("tabs")
            val ids = (0 until rows.length()).map { rows.getJSONObject(it).getString("id") }
            tabs.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, (0 until rows.length()).map { rows.getJSONObject(it).optString("title").ifBlank { rows.getJSONObject(it).optString("url") } })
            tabs.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
                override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: android.view.View?, position: Int, id: Long) { show(service, ids[position]) }
            }
            val selected = ids.indexOf(status.optString("active"))
            if (selected >= 0) { tabs.setSelection(selected); show(service, ids[selected]) }
        } }
    }
    private fun show(service: BrowserService, id: String) {
        val web = service.view(owner, id) ?: return
        while (body.childCount > 2) body.removeViewAt(2)
        (web.parent as? ViewGroup)?.removeView(web)
        body.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        url.setText(web.url ?: "")
    }
    override fun onDestroy() {
        while (body.childCount > 2) body.removeViewAt(2)
        super.onDestroy()
    }
}
