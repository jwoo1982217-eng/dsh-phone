package com.dshphone.control

import android.app.Application
import android.content.Intent
import android.content.pm.PackageInfo
import android.os.Bundle
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class TermuxCommandsTest {
    private val owner = "termux-session"
    private lateinit var ctx: Application
    @Before fun setup() {
        ctx = RuntimeEnvironment.getApplication(); ControlRuntime.attach(ctx); ControlRuntime.stop("test reset")
        shadowOf(ctx.packageManager).installPackage(PackageInfo().apply { packageName = "com.termux" })
        shadowOf(ctx).grantPermissions(TermuxCommands.PERMISSION)
        ControlRuntime.lease.claim(owner, "danger-full-access")
    }
    @After fun cleanup() { ControlRuntime.stop("test cleanup") }
    private fun args() = JSONObject().put("requestId", java.util.UUID.randomUUID().toString()).put("script", "printf '%s' 'literal $()'; exit 7").put("seconds", 5)
    private fun reply(command: Intent, stdout: String = "result", code: Int = 0) {
        val pending = command.getParcelableExtra<android.app.PendingIntent>("com.termux.RUN_COMMAND_PENDING_INTENT")!!
        pending.send(ctx, 0, Intent().putExtra("result", Bundle().apply { putString("stdout", stdout); putString("stderr", ""); putInt("exitCode", code); putInt("err", -1) }))
        shadowOf(android.os.Looper.getMainLooper()).idle()
        // Robolectric records the real PendingIntent broadcast; deliver its exact
        // payload to the production receiver (it does not start manifest receivers).
        TermuxResultReceiver().onReceive(ctx, shadowOf(ctx).broadcastIntents.last())
    }
    @Test fun commandUsesOfficialIntentAndOneShotResultReturnsExitCodeWithoutShellInterpolation() {
        val input = args(); val job = TermuxCommands.start(ctx, owner, input); val command = shadowOf(ctx).nextStartedService
        assertEquals("com.termux.RUN_COMMAND", command.action); assertEquals("com.termux.app.RunCommandService", command.component!!.className)
        assertTrue(command.getStringExtra("com.termux.RUN_COMMAND_PATH")!!.endsWith("/timeout"))
        assertEquals(input.getString("script"), command.getStringArrayExtra("com.termux.RUN_COMMAND_ARGUMENTS")!!.last())
        reply(command, "diagnostic-output", 7)
        val result = TermuxCommands.result(owner, job.getString("jobId")); assertEquals("completed", result.getString("status")); assertEquals(7, result.getInt("exitCode")); assertEquals("diagnostic-output", result.getString("stdout"))
    }
    @Test fun duplicateCommandIdDoesNotDispatchAgainAndChangedArgumentsAreRejected() {
        val input = args(); val first = TermuxCommands.start(ctx, owner, input); assertNotNull(shadowOf(ctx).nextStartedService)
        assertEquals(first.getString("jobId"), TermuxCommands.start(ctx, owner, input).getString("jobId")); assertNull(shadowOf(ctx).nextStartedService)
        try { TermuxCommands.start(ctx, owner, input.put("script", "other")); fail() } catch (_: IllegalStateException) {}
        assertNull(shadowOf(ctx).nextStartedService)
    }
    @Test fun stopCancelsTheCallbackAndDoesNotInventCommandTermination() {
        val job = TermuxCommands.start(ctx, owner, args()); val command = shadowOf(ctx).nextStartedService
        ControlRuntime.stop("user stop")
        assertEquals("revoked_after_dispatch", TermuxCommands.result(owner, job.getString("jobId")).getString("status"))
        try { reply(command); fail("callback must be cancelled") } catch (_: android.app.PendingIntent.CanceledException) {}
        try { TermuxCommands.start(ctx, owner, args()); fail() } catch (_: IllegalStateException) {}
        assertNull(shadowOf(ctx).nextStartedService)
    }
    @Test fun anotherSessionCannotReadACommandResult() {
        val job = TermuxCommands.start(ctx, owner, args())
        try { TermuxCommands.result("other-session", job.getString("jobId")); fail() } catch (_: IllegalStateException) {}
    }
    @Test fun taskModeCannotRunShellAndGrantRecoveryStillWorks() {
        ControlRuntime.stop("mode off"); ControlRuntime.lease.approve(ControlRuntime.lease.request(owner, "task only", setOf("com.termux"), 10).id)
        try { TermuxCommands.start(ctx, owner, args()); fail() } catch (_: IllegalStateException) {}
        assertNull(shadowOf(ctx).nextStartedService)
        ControlRuntime.lease.claim(owner, "danger-full-access")
        val job = TermuxCommands.start(ctx, owner, args()); reply(shadowOf(ctx).nextStartedService)
        assertEquals("completed", TermuxCommands.result(owner, job.getString("jobId")).getString("status"))
    }
    @Test fun outputIsBoundedAndCommonCredentialsAreRedacted() {
        val job = TermuxCommands.start(ctx, owner, args()); reply(shadowOf(ctx).nextStartedService, "a".repeat(49000) + "\nAuthorization: Bearer private-token-value")
        val value = TermuxCommands.result(owner, job.getString("jobId")); assertTrue(value.getBoolean("outputTruncated")); assertFalse(value.toString().contains("private-token-value")); assertTrue(value.getString("stdout").length <= 48000)
    }
}
