package com.dshphone.control

import android.content.ComponentCallbacks
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.TextView
import kotlin.math.max
import kotlin.math.roundToInt

/** A tap revokes control; a drag only moves the emergency stop affordance. */
internal class StopOverlay(
    private val context: Context,
    private val onStop: () -> Unit,
    private val manager: WindowManager = context.getSystemService(WindowManager::class.java),
    private val availableScreen: (() -> Rect)? = null,
) : ComponentCallbacks {
    internal var button: TextView? = null
        private set
    private val preferences = context.getSharedPreferences("phone-control-stop-position", Context.MODE_PRIVATE)
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private val params = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.LEFT // Physical coordinates remain stable in RTL locales.
        if (Build.VERSION.SDK_INT >= 30) setFitInsetsTypes(0)
    }
    private var attached = false
    private var fractionX = 1f
    private var fractionY = .08f
    private var tracking = false
    private var moved = false
    private var downX = 0f
    private var downY = 0f
    private var initialX = 0
    private var initialY = 0
    private fun dp(value: Int) = (value * context.resources.displayMetrics.density).roundToInt()
    private fun fraction(key: String, fallback: Float): Float =
        runCatching { preferences.getFloat(key, fallback) }.getOrDefault(fallback).let { if (it.isFinite()) it.coerceIn(0f, 1f) else fallback }

    fun show() {
        if (button != null) return
        fractionX = fraction("x", 1f); fractionY = fraction("y", .08f)
        val view = TextView(context).apply {
            text = "■ 停止操作"; textSize = 14f; setTextColor(Color.WHITE)
            contentDescription = "停止手机操作，按住拖动可移动位置"
            setBackgroundColor(Color.rgb(153, 27, 27)); setPadding(dp(12), dp(8), dp(12), dp(8))
            minHeight = dp(48); maxLines = 1
            filterTouchesWhenObscured = true
            setOnClickListener { onStop() }
            setOnTouchListener { _, event -> touch(event) }
            setOnApplyWindowInsetsListener { _, insets -> post { if (button === this && !tracking) reposition() }; insets }
        }
        button = view
        try {
            reposition()
            manager.addView(view, params); attached = true
            context.registerComponentCallbacks(this)
        } catch (error: Throwable) { button = null; throw error }
    }

    fun hide() {
        val view = button ?: return
        button = null; tracking = false
        if (attached) {
            attached = false
            context.unregisterComponentCallbacks(this)
            runCatching { manager.removeView(view) }
        }
    }

    private fun screen(): Rect {
        val result = availableScreen?.invoke()?.let(::Rect) ?: if (Build.VERSION.SDK_INT >= 30) {
            val metrics = manager.currentWindowMetrics
            val insets = metrics.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            Rect(insets.left, insets.top, metrics.bounds.width() - insets.right, metrics.bounds.height() - insets.bottom)
        } else {
            val metrics = android.util.DisplayMetrics().also { manager.defaultDisplay.getRealMetrics(it) }
            val insets = button?.rootWindowInsets
            fun dimension(name: String): Int {
                val id = context.resources.getIdentifier(name, "dimen", "android")
                return if (id == 0) 0 else context.resources.getDimensionPixelSize(id)
            }
            Rect(insets?.stableInsetLeft ?: 0, insets?.stableInsetTop ?: dimension("status_bar_height"),
                metrics.widthPixels - (insets?.stableInsetRight ?: 0), metrics.heightPixels - (insets?.stableInsetBottom ?: dimension("navigation_bar_height")))
        }
        val margin = dp(8).coerceAtMost(max(0, minOf(result.width(), result.height()) / 4))
        result.inset(margin, margin)
        return result
    }

    private fun limits(): Rect {
        val bounds = screen(); val view = checkNotNull(button)
        view.measure(View.MeasureSpec.makeMeasureSpec(max(1, bounds.width()), View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(max(1, bounds.height()), View.MeasureSpec.AT_MOST))
        return Rect(bounds.left, bounds.top, max(bounds.left, bounds.right - view.measuredWidth), max(bounds.top, bounds.bottom - view.measuredHeight))
    }

    private fun place(x: Int, y: Int) {
        val view = button ?: return
        val oldX = params.x; val oldY = params.y; val oldWidth = params.width; val oldHeight = params.height
        val limits = limits()
        params.x = x.coerceIn(limits.left, limits.right); params.y = y.coerceIn(limits.top, limits.bottom)
        params.width = view.measuredWidth; params.height = view.measuredHeight
        if (attached && (params.x != oldX || params.y != oldY || params.width != oldWidth || params.height != oldHeight)) try { manager.updateViewLayout(view, params) }
        catch (_: RuntimeException) { hide(); onStop() } // A missing stop window must not leave control active.
    }

    private fun reposition() {
        if (button == null) return
        tracking = false; button?.isPressed = false
        val limits = limits()
        place(limits.left + (limits.width() * fractionX).roundToInt(), limits.top + (limits.height() * fractionY).roundToInt())
    }

    private fun cancelDrag() {
        if (tracking && moved) place(initialX, initialY)
        tracking = false; button?.isPressed = false
    }

    private fun touch(event: MotionEvent): Boolean {
        val view = button ?: return true
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                if (!event.rawX.isFinite() || !event.rawY.isFinite()) return true
                tracking = true; moved = false; downX = event.rawX; downY = event.rawY
                initialX = params.x; initialY = params.y; view.isPressed = true
            }
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_CANCEL -> cancelDrag()
            MotionEvent.ACTION_MOVE, MotionEvent.ACTION_UP -> {
                if (!tracking) return true
                if (event.pointerCount != 1 || !event.rawX.isFinite() || !event.rawY.isFinite()) { cancelDrag(); return true }
                val dx = event.rawX - downX; val dy = event.rawY - downY
                if (dx * dx + dy * dy > slop.toFloat() * slop) moved = true
                if (moved) { view.isPressed = false; place(initialX + dx.roundToInt(), initialY + dy.roundToInt()) }
                if (event.actionMasked == MotionEvent.ACTION_UP) {
                    tracking = false; view.isPressed = false
                    if (moved && button === view) {
                        val limits = limits()
                        fractionX = if (limits.width() == 0) 0f else (params.x - limits.left).toFloat() / limits.width()
                        fractionY = if (limits.height() == 0) 0f else (params.y - limits.top).toFloat() / limits.height()
                        preferences.edit().putFloat("x", fractionX).putFloat("y", fractionY).apply()
                    } else if (!moved) view.performClick()
                }
            }
        }
        return true
    }

    override fun onConfigurationChanged(newConfig: Configuration) { reposition() }
    override fun onLowMemory() = Unit
}
