package com.dshphone.control

import android.accessibilityservice.AccessibilityService
import android.app.Activity
import android.app.Instrumentation
import android.app.UiAutomation
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.view.MotionEvent
import android.view.WindowInsets
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class OverlayFixtureActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(TextView(this).apply { text = "DSH 停止按钮拖动测试\n\n此页无账号、聊天或模型请求。"; textSize = 22f; setPadding(32, 180, 32, 32) })
    }
}
class OverlayFixtureService : AccessibilityService() {
    companion object { @Volatile var instance: OverlayFixtureService? = null }
    var stops = 0
    internal var overlay: StopOverlay? = null
    override fun onServiceConnected() { instance = this }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit
    override fun onDestroy() { overlay?.hide(); instance = null; super.onDestroy() }
    fun show() { overlay = StopOverlay(this, { stops++; overlay?.hide() }).also { it.show() } }
}
class OverlayInstrumentation : Instrumentation() {
    private lateinit var service: OverlayFixtureService
    private val cases = JSONArray()
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    private fun pause() { waitForIdleSync(); SystemClock.sleep(180) }
    private fun rect(): Rect {
        lateinit var r: Rect
        runOnMainSync { val b = service.overlay!!.button!!; val xy = IntArray(2); b.getLocationOnScreen(xy); r = Rect(xy[0], xy[1], xy[0]+b.width, xy[1]+b.height) }
        return r
    }
    private fun checkInside() {
        val r=rect(); val metrics=targetContext.getSystemService(WindowManager::class.java).currentWindowMetrics
        val insets=metrics.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        val safe=Rect(insets.left, insets.top, metrics.bounds.width()-insets.right, metrics.bounds.height()-insets.bottom)
        check(safe.contains(r)) { "Stop window outside safe screen: $r / $safe" }
    }
    private fun event(action: Int, x: Float, y: Float, down: Long) {
        val e=MotionEvent.obtain(down,SystemClock.uptimeMillis(),action,x,y,0)
        try { sendPointerSync(e) } finally { e.recycle() }
        SystemClock.sleep(40)
    }
    private fun drag(x: Float,y: Float,cancel: Boolean=false) {
        val r=rect(); val sx=r.exactCenterX(); val sy=r.exactCenterY(); val down=SystemClock.uptimeMillis()
        event(MotionEvent.ACTION_DOWN,sx,sy,down)
        for (i in 1..4) event(MotionEvent.ACTION_MOVE,sx+(x-sx)*i/4,sy+(y-sy)*i/4,down)
        event(if(cancel) MotionEvent.ACTION_CANCEL else MotionEvent.ACTION_UP,x,y,down); pause()
    }
    private fun passed(name: String) { cases.put(name); sendStatus(0, Bundle().apply { putString("stream","PASS: $name\n") }) }
    override fun onStart() {
        val report=JSONObject().put("cases",cases)
        var activity: Activity?=null
        try {
            check(targetContext.packageName.startsWith("com.dshphone.stopoverlayverification."))
            // Preserve production accessibility services while taking the fixture screenshot.
            val automation=getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
            automation.adoptShellPermissionIdentity("android.permission.WRITE_SECURE_SETTINGS")
            try {
                val component=targetContext.packageName+"/com.dshphone.control.OverlayFixtureService"
                val current=Settings.Secure.getString(targetContext.contentResolver,Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
                val services=current.split(':').filter { it.isNotBlank() && it!="null" && it!=component }
                check(Settings.Secure.putString(targetContext.contentResolver,Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,(services+component).joinToString(":")))
                check(Settings.Secure.putInt(targetContext.contentResolver,Settings.Secure.ACCESSIBILITY_ENABLED,1))
            } finally { automation.dropShellPermissionIdentity() }
            val deadline=SystemClock.uptimeMillis()+15000
            while(OverlayFixtureService.instance==null && SystemClock.uptimeMillis()<deadline) SystemClock.sleep(100)
            service=checkNotNull(OverlayFixtureService.instance) { "Test accessibility service did not connect" }
            activity=startActivitySync(Intent(targetContext,OverlayFixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            pause(); runOnMainSync { service.show() }; pause(); checkInside(); passed("real accessibility window visible")
            val before=rect(); val wm=targetContext.getSystemService(WindowManager::class.java); val size=wm.currentWindowMetrics.bounds
            drag(size.width()*.40f,size.height()*.45f); val after=rect()
            check(kotlin.math.abs(after.left-before.left)>40 && kotlin.math.abs(after.top-before.top)>40 && service.stops==0); checkInside(); passed("physical touch drag moves without stop")
            check(activity.hasWindowFocus())
            automation.takeScreenshot()!!.let { image -> File(targetContext.filesDir,"overlay-drag.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG,100,it) }; image.recycle() }
            val saved=rect(); runOnMainSync { service.overlay!!.hide(); service.show() }; pause()
            check(kotlin.math.abs(rect().left-saved.left)<=2 && kotlin.math.abs(rect().top-saved.top)<=2); passed("new window restores released location")
            val restored=rect(); drag(size.width()*.75f,size.height()*.65f,true)
            check(rect()==restored && service.stops==0); passed("cancelled gesture restores location without stop")
            drag(2f,2f); checkInside(); drag(size.width()-2f,size.height()-2f); checkInside(); check(service.stops==0); passed("all screen edges stay reachable")
            runOnMainSync { activity.requestedOrientation=ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }; SystemClock.sleep(1300); pause()
            check(wm.currentWindowMetrics.bounds.width()>wm.currentWindowMetrics.bounds.height()); checkInside(); passed("rotation retains a visible stop window")
            runOnMainSync { activity.requestedOrientation=ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }; SystemClock.sleep(1300); pause(); checkInside()
            val r=rect(); val down=SystemClock.uptimeMillis(); event(MotionEvent.ACTION_DOWN,r.exactCenterX(),r.exactCenterY(),down); event(MotionEvent.ACTION_UP,r.exactCenterX(),r.exactCenterY(),down); pause()
            check(service.stops==1 && service.overlay!!.button==null); passed("single tap still stops exactly once")
            runOnMainSync { service.show() }; pause(); checkInside(); check(service.stops==1); passed("window can be shown again after stop")
            report.put("passed",true).put("realWindowType",WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY)
            finish(Activity.RESULT_OK,Bundle().apply { putString("stream","DSH_STOP_OVERLAY_OK\n$report\n") })
        } catch(e: Throwable) {
            report.put("passed",false).put("error",e.toString())
            finish(Activity.RESULT_CANCELED,Bundle().apply { putString("stream","DSH_STOP_OVERLAY_FAILED\n$report\n") })
        } finally { runOnMainSync { if(::service.isInitialized) service.overlay?.hide(); activity?.finish() } }
    }
}
