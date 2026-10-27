package com.dshphone.control

import android.app.Application
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.json.JSONObject
import java.time.Duration

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
@LooperMode(LooperMode.Mode.PAUSED)
class ControlSetupTest {
    private fun labels(view: View): List<String> = when (view) {
        is Button -> listOf(view.text.toString())
        is ViewGroup -> (0 until view.childCount).flatMap { labels(view.getChildAt(it)) }
        else -> emptyList()
    }
    @Test fun oneEntryChecksBackendsWithoutAnotherTaskConsentSwitch() {
        shadowOf(RuntimeEnvironment.getApplication() as Application).grantPermissions("android.permission.HIDE_OVERLAY_WINDOWS")
        val activity = Robolectric.buildActivity(ControlActivity::class.java).setup().get()
        try {
            val buttons = labels(activity.window.decorView)
            assertTrue("missing unified setup entry", buttons.contains("开启并检查"))
            assertFalse(buttons.any { it.contains("开启连续控制") })
        } finally { activity.finish() }
    }
    @Test fun existingShizukuGrantCanRepairAccessibilityWithoutAnotherConsent() {
        val state = JSONObject().put("accessibilityConnected", false)
            .put("logs", JSONObject().put("running", true).put("permissionGranted", true))
            .put("termux", JSONObject().put("installed", true).put("permissionGranted", true))
        assertEquals(ControlSetup.Step.REPAIR_ACCESSIBILITY, ControlSetup.next(state, true, true))
        state.put("accessibilityConnected", true)
        assertEquals(ControlSetup.Step.DONE, ControlSetup.next(state, true, true))
    }
    @Test fun unavailableLogsDoNotInvalidateWorkingScreenControl() {
        val state = JSONObject().put("accessibilityConnected", true)
            .put("logs", JSONObject().put("running", false).put("permissionGranted", false))
            .put("termux", JSONObject().put("installed", true).put("permissionGranted", true))
        assertEquals(ControlSetup.Step.START_SHIZUKU, ControlSetup.next(state, true, false))
        assertEquals(ControlSetup.Step.DONE, ControlSetup.next(state, false, false))
    }
    @Test fun mergingOwnServiceKeepsOtherAppsAndDoesNotDuplicateShortComponents() {
        val own = "com.dshphone/com.dshphone.control.PhoneControlService"
        assertEquals("bin.mt.plus/bin.mt.function.ar.ActivityRecordService:$own",
            ControlRepairService.mergeServices("bin.mt.plus/bin.mt.function.ar.ActivityRecordService", own))
        assertEquals("com.dshphone/.control.PhoneControlService:other.app/.Service",
            ControlRepairService.mergeServices("com.dshphone/.control.PhoneControlService:other.app/.Service", own))
        assertEquals(own, ControlRepairService.mergeServices("null", own))
    }
    @Test fun setupDoesNotClaimChatPermissionsAndCancellationDoesNotLoopSettings() {
        val app = RuntimeEnvironment.getApplication() as Application
        shadowOf(app).grantPermissions("android.permission.HIDE_OVERLAY_WINDOWS")
        app.getSharedPreferences("phone-control-setup", 0).edit().clear().commit()
        ControlRuntime.attach(app); ControlRuntime.stop("test"); ControlRuntime.service = null
        val controller = Robolectric.buildActivity(ControlActivity::class.java).setup()
        val activity = controller.get()
        fun find(view: View): Button? = when (view) {
            is Button -> view.takeIf { it.text.toString() == "开启并检查" }
            is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { find(view.getChildAt(it)) }
            else -> null
        }
        try {
            find(activity.window.decorView)!!.performClick()
            assertTrue(ControlRepair.automaticEnabled(app))
            assertTrue(ControlRuntime.status().getBoolean("automaticReconnectEnabled"))
            assertFalse(ControlRuntime.status().getBoolean("automaticReconnectAvailable"))
            assertNull(ControlRuntime.lease.current())
            assertNotNull(shadowOf(activity).nextStartedActivity)
            controller.pause().resume()
            shadowOf(android.os.Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
            assertNull("unchanged/cancelled setup must not reopen settings", shadowOf(activity).nextStartedActivity)
        } finally { controller.pause().stop().destroy(); app.getSharedPreferences("phone-control-setup", 0).edit().clear().commit() }
    }
    @Test fun missingShizukuFailsRecoveryWithoutRevokingExistingChatPermission() {
        val app = RuntimeEnvironment.getApplication() as Application
        ControlRuntime.attach(app); ControlRuntime.stop("test reset"); ControlRuntime.service = null
        ControlRepair.enableAutomatic(app)
        val owner = "session-recovery-test"
        val sync = ControlRuntime.call(app, JSONObject().put("command", "session").put("owner", owner)
            .put("mode", "danger-full-access").put("intentAt", System.currentTimeMillis() + 1000))
        shadowOf(android.os.Looper.getMainLooper()).idle(); sync.get()
        val epoch = ControlRuntime.lease.current()!!.epoch
        val action = ControlRuntime.call(app, JSONObject().put("command", "execute").put("owner", owner)
            .put("epoch", epoch).put("requestId", java.util.UUID.randomUUID().toString())
            .put("args", JSONObject().put("action", "launch").put("package", "com.example.app")))
        shadowOf(android.os.Looper.getMainLooper()).idle()
        try {
            assertTrue(action.isCompletedExceptionally)
            assertEquals(epoch, ControlRuntime.lease.current()!!.epoch)
            assertEquals("danger-full-access", ControlRuntime.lease.current()!!.policyMode)
            assertFalse(ControlRuntime.status().getBoolean("paused"))
        } finally { ControlRuntime.stop("test cleanup"); app.getSharedPreferences("phone-control-setup", 0).edit().clear().commit() }
    }
}
