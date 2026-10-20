package com.dshphone.control

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.Rect
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.WindowManager
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35])
@LooperMode(LooperMode.Mode.PAUSED)
class StopOverlayTest {
    private lateinit var activity: Activity
    private lateinit var overlay: StopOverlay
    private var bounds = Rect(20, 60, 1000, 1900)
    private var stops = 0
    private val params get() = overlay.button!!.layoutParams as WindowManager.LayoutParams
    @Before fun setUp() {
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        activity.getSharedPreferences("phone-control-stop-position", Context.MODE_PRIVATE).edit().clear().commit()
        overlay = create(); overlay.show(); shadowOf(Looper.getMainLooper()).idle()
    }
    @After fun tearDown() { overlay.hide(); activity.finish() }
    private fun create() = StopOverlay(activity, { stops++ }, availableScreen = { bounds })
    private fun touch(action: Int, x: Float, y: Float) {
        val event = MotionEvent.obtain(0, SystemClock.uptimeMillis(), action, x, y, 0)
        try { assertTrue(overlay.button!!.dispatchTouchEvent(event)) } finally { event.recycle() }
    }
    private fun drag(dx: Float, dy: Float) {
        touch(MotionEvent.ACTION_DOWN, 100f, 100f); touch(MotionEvent.ACTION_MOVE, 100f + dx, 100f + dy)
        touch(MotionEvent.ACTION_UP, 100f + dx, 100f + dy)
    }
    private fun inside() {
        assertTrue(params.x >= bounds.left); assertTrue(params.y >= bounds.top)
        assertTrue(params.x + params.width <= bounds.right); assertTrue(params.y + params.height <= bounds.bottom)
    }
    @Test fun dragMovesWithoutStoppingAndSubsequentTapStillStops() {
        val x = params.x; val y = params.y
        drag(-250f, 350f); assertEquals(x - 250, params.x); assertEquals(y + 350, params.y); assertEquals(0, stops)
        touch(MotionEvent.ACTION_DOWN, 10f, 10f); touch(MotionEvent.ACTION_UP, 12f, 11f); assertEquals(1, stops)
    }
    @Test fun largeUpWithoutAnIntermediateMoveCannotAccidentallyStop() {
        touch(MotionEvent.ACTION_DOWN, 100f, 100f); touch(MotionEvent.ACTION_UP, 400f, 500f); assertEquals(0, stops)
    }
    @Test fun returningToTheStartingPointAfterDraggingIsStillNotATap() {
        touch(MotionEvent.ACTION_DOWN, 100f, 100f); touch(MotionEvent.ACTION_MOVE, 40f, 600f)
        touch(MotionEvent.ACTION_MOVE, 100f, 100f); touch(MotionEvent.ACTION_UP, 100f, 100f); assertEquals(0, stops)
    }
    @Test fun cancelledDragRestoresPositionAndDoesNotWritePreferencesOrStop() {
        val x = params.x; val y = params.y
        touch(MotionEvent.ACTION_DOWN, 100f, 100f); touch(MotionEvent.ACTION_MOVE, -100f, 700f)
        touch(MotionEvent.ACTION_CANCEL, -100f, 700f)
        assertEquals(x, params.x); assertEquals(y, params.y); assertEquals(0, stops)
        assertTrue(activity.getSharedPreferences("phone-control-stop-position", 0).all.isEmpty())
        touch(MotionEvent.ACTION_DOWN, 10f, 10f); touch(MotionEvent.ACTION_UP, 10f, 10f); assertEquals(1, stops)
    }
    @Test fun extraPointerCancelsTheGestureWithoutStopping() {
        touch(MotionEvent.ACTION_DOWN, 100f, 100f); touch(MotionEvent.ACTION_POINTER_DOWN, 100f, 100f)
        touch(MotionEvent.ACTION_UP, 100f, 100f); assertEquals(0, stops)
    }
    @Test fun extremeDragsRemainFullyOnScreen() {
        drag(-100000f, -100000f); inside(); drag(100000f, 100000f); inside(); assertEquals(0, stops)
    }
    @Test fun recreatedWindowRestoresTheReleasedPosition() {
        drag(-270f, 410f); val x = params.x; val y = params.y
        overlay.hide(); overlay = create(); overlay.show(); shadowOf(Looper.getMainLooper()).idle()
        assertEquals(x.toDouble(), params.x.toDouble(), 1.0); assertEquals(y.toDouble(), params.y.toDouble(), 1.0)
    }
    @Test fun rotationKeepsTheSavedRelativePositionInsideTheNewScreen() {
        drag(-270f, 700f); bounds = Rect(70, 20, 1850, 900)
        overlay.onConfigurationChanged(Configuration()); inside(); assertEquals(0, stops)
    }
    @Test fun invalidStoredCoordinatesFallBackToAVisibleButton() {
        overlay.hide()
        activity.getSharedPreferences("phone-control-stop-position", 0).edit().putFloat("x", Float.NaN).putString("y", "invalid").commit()
        overlay = create(); overlay.show(); shadowOf(Looper.getMainLooper()).idle(); inside(); assertEquals(0, stops)
    }
    @Test fun accessibilityClickStillStopsImmediately() { assertTrue(overlay.button!!.performClick()); assertEquals(1, stops) }
}
