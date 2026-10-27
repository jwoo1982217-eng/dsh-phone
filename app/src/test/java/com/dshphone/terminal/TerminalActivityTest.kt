package com.dshphone.terminal

import android.app.Application
import android.content.Intent
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.Shadows.shadowOf
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[35], application=Application::class)
@LooperMode(LooperMode.Mode.PAUSED)
class TerminalActivityTest {
    class FixtureActivity : TerminalActivity() {
        val commands = ByteArrayOutputStream()
        val stopped = CountDownLatch(1)
        private val exit = CountDownLatch(1)
        override fun createSession() = ShellSession(ShellSession.Factory {
            object : ShellSession.Child {
                override val stdout = ByteArrayInputStream("fixture-output".toByteArray())
                override val stdin = commands
                override fun waitFor(): Int { exit.await(5,TimeUnit.SECONDS); return 0 }
                override fun terminate(): String? { stopped.countDown(); exit.countDown(); return null }
            }
        })
    }
    private fun idleUntil(check: () -> Boolean) {
        val end = System.nanoTime()+TimeUnit.SECONDS.toNanos(5)
        do { shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(50)); if (check()) return; Thread.sleep(10) }
        while (System.nanoTime()<end)
        assertTrue(check())
    }
    @Test fun nativeControlsNeverExecuteIntentExtrasAndStopOnDestroy() {
        val controller = Robolectric.buildActivity(FixtureActivity::class.java,
            Intent().putExtra("command", "do-not-run").setData(android.net.Uri.parse("https://untrusted.invalid/?cmd=bad")))
            .setup()
        val activity=controller.get()
        val send=activity.findViewById<Button>(TerminalActivity.SEND_ID)
        idleUntil { send.isEnabled }
        assertEquals("",activity.commands.toString("UTF-8"))
        assertTrue(activity.findViewById<TextView>(TerminalActivity.INFO_ID).text.contains("非 PTY"))
        activity.findViewById<EditText>(TerminalActivity.INPUT_ID).setText("printf user-entered")
        send.performClick()
        idleUntil { activity.commands.toString("UTF-8").contains("printf user-entered\n") }
        controller.pause().stop().destroy()
        assertTrue(activity.stopped.await(2,TimeUnit.SECONDS))
    }
    @Test fun inputIsBoundedAndClosingDoesNotLeaveOutputCallbacks() {
        val controller=Robolectric.buildActivity(FixtureActivity::class.java).setup()
        val activity=controller.get()
        activity.findViewById<EditText>(TerminalActivity.INPUT_ID).setText("x".repeat(9000))
        assertEquals(8192,activity.findViewById<EditText>(TerminalActivity.INPUT_ID).length())
        controller.pause().stop().destroy()
        assertTrue(activity.stopped.await(2,TimeUnit.SECONDS))
        shadowOf(android.os.Looper.getMainLooper()).idle()
    }
}
