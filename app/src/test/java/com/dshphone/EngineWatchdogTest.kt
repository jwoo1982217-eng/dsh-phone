package com.dshphone

import android.app.Application
import android.os.Handler
import org.junit.Assert.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
@LooperMode(LooperMode.Mode.PAUSED)
class EngineWatchdogTest {
    private lateinit var service: DshService
    private class Child(private val alive: Boolean) : Process() {
        var destroyed = false
        override fun getOutputStream() = ByteArrayOutputStream()
        override fun getInputStream() = ByteArrayInputStream(byteArrayOf())
        override fun getErrorStream() = ByteArrayInputStream(byteArrayOf())
        override fun waitFor() = 7
        override fun exitValue(): Int { if (alive) throw IllegalThreadStateException(); return 7 }
        override fun isAlive() = alive && !destroyed
        override fun destroy() { destroyed = true }
    }
    private fun field(name: String) = DshService::class.java.getDeclaredField(name).apply { isAccessible=true }
    private fun setProcess(value: Process?) {field("process").set(null,value)}
    private fun call(name: String) {DshService::class.java.getDeclaredMethod(name).apply {isAccessible=true}.invoke(service)}
    @Before fun setup() {
        service=Robolectric.buildService(DshService::class.java).get()
        setProcess(null);field("restartPaused").setBoolean(null,false)
    }
    @After fun cleanup() {
        (field("handler").get(service) as Handler).removeCallbacksAndMessages(null)
        (field("work").get(service) as ExecutorService).shutdownNow()
        setProcess(null);field("restartPaused").setBoolean(null,false)
    }
    @Test fun liveChildNeverRestartsOrConsumesBackoffBudget() {
        val child=Child(true);setProcess(child)
        repeat(20) {(field("watchdog").get(service) as Runnable).run()}
        call("startNode")
        assertFalse(child.destroyed);assertSame(child,DshService.process)
        assertNull(field("pendingRestart").get(service))
        assertFalse(DshService.restartPaused)
    }
    @Test fun oneDeadChildSchedulesExactlyOneRetryAndClearingItStopsTheTimer() {
        val child=Child(false);setProcess(child)
        val watchdog=field("watchdog").get(service) as Runnable
        watchdog.run();val retry=field("pendingRestart").get(service)
        assertNotNull(retry);assertNull(DshService.process)
        repeat(20) {watchdog.run()};assertSame(retry,field("pendingRestart").get(service))
        call("clearPendingRestart");assertNull(field("pendingRestart").get(service))
    }
    @Test fun repeatedLaunchFailuresOpenCircuitWithoutTouchingProgramOrConfig() {
        val schedule=DshService::class.java.getDeclaredMethod("scheduleDeadRestart",String::class.java).apply {isAccessible=true}
        repeat(11) {schedule.invoke(service,"fixture failure");call("clearPendingRestart")}
        schedule.invoke(service,"fixture failure")
        assertTrue(DshService.restartPaused);assertNull(field("pendingRestart").get(service))
        assertNull(DshService.process)
    }
}
