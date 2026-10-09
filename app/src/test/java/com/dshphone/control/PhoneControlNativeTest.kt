package com.dshphone.control

import android.app.Application
import android.graphics.Rect
import android.os.Looper
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
@LooperMode(LooperMode.Mode.PAUSED)
class PhoneControlNativeTest {
    private lateinit var service: PhoneControlService
    private lateinit var root: AccessibilityNodeInfo
    private lateinit var button: AccessibilityNodeInfo
    private val owner = "session-a"
    private var epoch = 0L
    @Before fun setUp() {
        ControlRuntime.attach(RuntimeEnvironment.getApplication()); ControlRuntime.stop("test reset")
        service = Robolectric.buildService(PhoneControlService::class.java).create().get(); ControlRuntime.service = service
        root = AccessibilityNodeInfo.obtain().apply { packageName = "com.example.app"; isVisibleToUser = true; isEnabled = true; setBoundsInScreen(Rect(0, 0, 1080, 2000)) }
        button = AccessibilityNodeInfo.obtain().apply { packageName = "com.example.app"; text = "搜索"; isVisibleToUser = true; isEnabled = true; isClickable = true; setBoundsInScreen(Rect(10, 50, 300, 100)) }
        shadowOf(root).addChild(button); shadowOf(button).setOnPerformActionListener { _, _ -> true }
        shadowOf(service).setRootInActiveWindow(root)
        epoch = ControlRuntime.lease.approve(ControlRuntime.lease.request(owner, "test navigation", setOf("com.example.app"), 10).id).epoch
    }
    @After fun tearDown() { ControlRuntime.stop("test cleanup"); ControlRuntime.service = null }
    private fun action(args: JSONObject): JSONObject {
        var result: JSONObject? = null; service.execute(owner, epoch, args, false) { result = it }; return result ?: error("no native result")
    }
    private fun read() = action(JSONObject().put("action", "read"))
    private fun click(snapshot: JSONObject, id: String = "n1") = JSONObject().put("action", "click").put("snapshotId", snapshot.getString("snapshotId")).put("nodeId", id)
    private fun reject(block: () -> Unit) { try { block(); fail("must reject") } catch (_: IllegalStateException) {} }
    @Test fun readThenNavigationUsesTheRealServiceAndNodeAction() {
        val snapshot = read(); assertEquals("com.example.app", snapshot.getString("package")); assertEquals(2, snapshot.getJSONArray("nodes").length())
        assertEquals("performed", action(click(snapshot)).getString("status")); assertEquals(listOf(AccessibilityNodeInfo.ACTION_CLICK), shadowOf(button).performedActions)
        reject { action(click(snapshot)) }
    }
    @Test fun changedLabelRejectsTheOldSnapshotWithoutClicking() { val snapshot = read(); button.text = "删除"; reject { action(click(snapshot)) }; assertTrue(shadowOf(button).performedActions.isEmpty()) }
    @Test fun changedForegroundAndMissingPackageAreRejected() {
        root.packageName = "com.other.app"; reject { read() }; root.packageName = null; reject { read() }
    }
    @Test fun passwordTextIsRedactedAndCannotBeEditedOrClicked() {
        button.text = "secret-not-to-be-returned"; button.isPassword = true; button.isEditable = true
        val snapshot = read(); assertFalse(snapshot.toString().contains("secret-not-to-be-returned"))
        reject { action(click(snapshot)) }; reject { action(JSONObject().put("action", "input").put("snapshotId", snapshot.getString("snapshotId")).put("nodeId", "n1").put("text", "new")) }
    }
    @Test fun sensitiveClickWaitsForNativeApprovalAndCanExecuteOnlyOnce() {
        button.text = "发送"; val args = click(read()); val pending = action(args)
        assertEquals("confirmation_required", pending.getString("status")); assertTrue(shadowOf(button).performedActions.isEmpty())
        ControlRuntime.approveAction(pending.getString("confirmationId"))
        val fresh = read(); args.put("snapshotId", fresh.getString("snapshotId")).put("confirmationId", pending.getString("confirmationId"))
        assertEquals("performed", action(args).getString("status")); assertEquals(1, shadowOf(button).performedActions.size)
        args.put("snapshotId", read().getString("snapshotId")); assertEquals("confirmation_required", action(args).getString("status"))
    }
    @Test fun nativeConfirmationCannotBeRedirectedToAnotherNode() {
        root.isClickable = true; button.text = "发送"; val args = click(read()); val pending = action(args); ControlRuntime.approveAction(pending.getString("confirmationId"))
        args.put("snapshotId", read().getString("snapshotId")).put("nodeId", "n0").put("confirmationId", pending.getString("confirmationId"))
        reject { action(args) }; assertTrue(shadowOf(button).performedActions.isEmpty())
    }
    @Test fun stopAfterConfirmationInvalidatesIt() {
        button.text = "删除"; val args = click(read()); val pending = action(args); ControlRuntime.approveAction(pending.getString("confirmationId")); ControlRuntime.stop("user stop")
        reject { action(args.put("confirmationId", pending.getString("confirmationId"))) }; assertTrue(shadowOf(button).performedActions.isEmpty())
    }
    @Test fun nativeRuntimeRejectsQueuedCancelledCallsAndDeduplicatesMutationIds() {
        val id = java.util.UUID.randomUUID().toString(); val args = click(read())
        fun payload(command: String) = JSONObject().put("command", command).put("owner", owner).put("epoch", epoch).put("requestId", id).put("args", args)
        val first = ControlRuntime.call(service, payload("execute")); shadowOf(Looper.getMainLooper()).idle(); assertEquals("performed", first.get().getString("status"))
        val duplicate = ControlRuntime.call(service, payload("execute")); shadowOf(Looper.getMainLooper()).idle(); assertEquals("performed", duplicate.get().getString("status")); assertEquals(1, shadowOf(button).performedActions.size)
        val altered = payload("execute").put("args", JSONObject().put("action", "back"))
        val changed = ControlRuntime.call(service, altered); shadowOf(Looper.getMainLooper()).idle(); assertTrue(changed.isCompletedExceptionally); assertEquals(1, shadowOf(button).performedActions.size)
        val cancelled = ControlRuntime.call(service, payload("cancel")); shadowOf(Looper.getMainLooper()).idle(); assertEquals("cancelled", cancelled.get().getString("status")); assertNull(ControlRuntime.lease.current())
        val retry = ControlRuntime.call(service, payload("execute")); shadowOf(Looper.getMainLooper()).idle(); assertTrue(retry.isCompletedExceptionally)
    }
    @Test fun appRejectionReportsFailureWithoutFabricatedSuccess() { shadowOf(button).setOnPerformActionListener { _, _ -> false }; reject { action(click(read())) } }
    @Test fun textEntryScrollAndBackUseThePlatformActions() {
        button.isEditable = true; button.isScrollable = true
        var snapshot = read()
        action(JSONObject().put("action", "input").put("snapshotId", snapshot.getString("snapshotId")).put("nodeId", "n1").put("text", "天气"))
        val input = shadowOf(button).performedActionsWithArgs.last()
        assertEquals(AccessibilityNodeInfo.ACTION_SET_TEXT, input.first.toInt()); assertEquals("天气", input.second.getCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE))
        snapshot = read(); action(JSONObject().put("action", "scroll").put("snapshotId", snapshot.getString("snapshotId")).put("nodeId", "n1").put("direction", "forward"))
        assertEquals(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD, shadowOf(button).performedActions.last().toInt())
        snapshot = read(); action(JSONObject().put("action", "back").put("snapshotId", snapshot.getString("snapshotId")))
        assertEquals(listOf(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK), shadowOf(service).globalActionsPerformed)
    }
    @Test fun coordinateSwipeRequiresExactApprovalAndWaitsForAndroidCompletion() {
        val args = JSONObject().put("action", "swipe").put("snapshotId", read().getString("snapshotId")).put("x", 100).put("y", 200).put("endX", 100).put("endY", 800)
        val pending = action(args); assertEquals("confirmation_required", pending.getString("status")); assertTrue(shadowOf(service).gesturesDispatched.isEmpty())
        ControlRuntime.approveAction(pending.getString("confirmationId")); args.put("snapshotId", read().getString("snapshotId")).put("confirmationId", pending.getString("confirmationId"))
        var result: JSONObject? = null; service.execute(owner, epoch, args, false) { result = it }
        assertNull(result); val gesture = shadowOf(service).gesturesDispatched.single(); gesture.callback().onCompleted(gesture.description())
        assertEquals("performed", result!!.getString("status")); reject { action(args) }
    }
    @Test fun aDisabledOrObscuredButtonDoesNotExecute() {
        button.isEnabled = false; reject { action(click(read())) }; button.isEnabled = true; button.isVisibleToUser = false; reject { action(click(read())) }; assertTrue(shadowOf(button).performedActions.isEmpty())
    }
    @Test fun lockedPhoneRejectsReadsAndLaunches() {
        shadowOf(service.getSystemService(android.content.Context.KEYGUARD_SERVICE) as android.app.KeyguardManager).setKeyguardLocked(true)
        reject { read() }; reject { action(JSONObject().put("action", "launch").put("package", "com.example.app")) }
    }
    private fun continuous() {
        epoch = ControlRuntime.lease.claim(owner, "danger-full-access").epoch
    }
    @Test fun continuousSensitiveButtonsExecuteRepeatedlyWithoutApprovalButStopRevokesThem() {
        continuous(); button.text = "发送"; assertEquals("performed", action(click(read())).getString("status"))
        button.text = "删除"; assertEquals("performed", action(click(read())).getString("status")); assertEquals(2, shadowOf(button).performedActions.size)
        val beforeStop = click(read()); ControlRuntime.stop("human stop"); reject { action(beforeStop) }
        assertNull(ControlRuntime.lease.current()); assertEquals(2, shadowOf(button).performedActions.size)
    }
    @Test fun continuousModeStillRejectsStaleScreensAndPasswords() {
        continuous(); val old = click(read()); button.text = "删除"; reject { action(old) }
        button.isPassword = true; reject { action(click(read())) }; assertTrue(shadowOf(button).performedActions.isEmpty())
        reject { action(JSONObject().put("action", "screenshot")) }
        root.packageName = "com.android.settings"; reject { read() }
    }
    @Test fun continuousLongClickAndLongPressUseActualAndroidActionsAndCallbacks() {
        continuous(); button.isLongClickable = true
        assertEquals("performed", action(click(read()).put("action", "long_click")).getString("status"))
        assertEquals(AccessibilityNodeInfo.ACTION_LONG_CLICK, shadowOf(button).performedActions.single().toInt())
        val args = JSONObject().put("action", "long_press").put("snapshotId", read().getString("snapshotId")).put("x", 100).put("y", 200)
        var result: JSONObject? = null; service.execute(owner, epoch, args, false) { result = it }
        val gesture = shadowOf(service).gesturesDispatched.single(); assertEquals(800, gesture.description().getStroke(0).duration)
        assertNull(result); gesture.callback().onCompleted(gesture.description()); assertEquals("performed", result!!.getString("status"))
    }
    @Test fun bridgeCannotEnableContinuousModeOrAuthorizeItself() {
        ControlRuntime.stop("reset")
        for (command in listOf("enableContinuous", "approve", "authorize")) {
            val call = ControlRuntime.call(service, JSONObject().put("command", command).put("owner", owner)); shadowOf(Looper.getMainLooper()).idle(); assertTrue(call.isCompletedExceptionally)
        }
        assertNull(ControlRuntime.lease.current())
    }
    @Test fun nativePageHasSystemSetupButNoExtraContinuousEnableSwitch() {
        shadowOf(RuntimeEnvironment.getApplication() as Application).grantPermissions("android.permission.HIDE_OVERLAY_WINDOWS")
        val activity = Robolectric.buildActivity(ControlActivity::class.java).setup().get()
        fun buttons(view: android.view.View): List<android.widget.Button> = when (view) {
            is android.widget.Button -> listOf(view)
            is android.view.ViewGroup -> (0 until view.childCount).flatMap { buttons(view.getChildAt(it)) }
            else -> emptyList()
        }
        val labels = buttons(activity.window.decorView).map { it.text.toString() }
        assertTrue(labels.contains("打开系统无障碍设置")); assertFalse(labels.any { it.contains("开启连续控制") }); activity.finish()
    }
    @Test fun nativeSessionModesPermitViewingButMutationsNeedExistingFullMode() {
        for (mode in listOf("read-only", "workspace-write")) {
            epoch = ControlRuntime.lease.claim(owner, mode).epoch; assertEquals("observed", read().getString("status"))
            reject { action(click(read())) }; reject { action(JSONObject().put("action", "launch").put("package", "com.example.app")) }
        }
        epoch = ControlRuntime.lease.claim(owner, "danger-full-access").epoch; button.text = "发送"
        assertEquals("performed", action(click(read())).getString("status")); assertEquals(1, shadowOf(button).performedActions.size)
        root.packageName = "com.other.app"; assertEquals("com.other.app", read().getString("package"))
    }
    @Test fun stopBlocksTheOldIntentAndNewHumanIntentCanResumeWithoutNativeApproval() {
        fun sync(at: Long) = ControlRuntime.call(service, JSONObject().put("command", "session").put("owner", owner).put("mode", "danger-full-access").put("intentAt", at))
        ControlRuntime.stop("human stop"); val old = sync(0); shadowOf(Looper.getMainLooper()).idle(); assertTrue(old.isCompletedExceptionally)
        val next = sync(System.currentTimeMillis() + 1000); shadowOf(Looper.getMainLooper()).idle(); assertEquals("authorized", next.get().getString("status"))
        epoch = ControlRuntime.lease.current()!!.epoch; button.text = "发送"; assertEquals("performed", action(click(read())).getString("status"))
    }
}
