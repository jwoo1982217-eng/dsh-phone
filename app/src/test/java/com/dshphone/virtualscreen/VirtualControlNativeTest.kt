package com.dshphone.virtualscreen

import android.os.Looper
import com.dshphone.control.ControlRuntime
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.UUID
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[34])
class VirtualControlNativeTest {
    private val context get() = RuntimeEnvironment.getApplication()
    @After fun clean() { ControlRuntime.stop("fixture end") }
    private fun sync(mode: String): Long {
        val f = ControlRuntime.call(context,JSONObject().put("command","session").put("owner","virtual-fixture").put("mode",mode).put("intentAt",System.currentTimeMillis()+10000))
        shadowOf(Looper.getMainLooper()).idle(); assertEquals("authorized",f.get().getString("status")); return ControlRuntime.lease.current()!!.epoch
    }
    private fun call(epoch: Long, action: String) = ControlRuntime.call(context,JSONObject().put("command","virtual").put("owner","virtual-fixture").put("epoch",epoch)
        .put("requestId",UUID.randomUUID().toString()).put("args",JSONObject().put("action",action).put("screenId","virtual-1")))
    @Test fun readOnlyCannotCreateDestroyOrGesture() {
        val epoch = sync("read-only")
        for (action in listOf("create","destroy","launch","tap","swipe","back")) {
            val result = call(epoch,action); shadowOf(Looper.getMainLooper()).idle()
            assertTrue(result.isCompletedExceptionally)
            try { result.get(); fail() } catch (error: java.util.concurrent.ExecutionException) {
                assertTrue(error.cause?.message.orEmpty(),error.cause?.message.orEmpty().contains("完全权限"))
            }
        }
        assertEquals("idle",VirtualScreenController.status().getString("status"))
    }
    @Test fun virtualStatusIsAvailableWithoutReadingOrCreatingAnyDisplay() {
        val result = call(sync("read-only"),"status")
        repeat(100) { shadowOf(Looper.getMainLooper()).idle(); if (!result.isDone) Thread.sleep(5) }
        assertEquals("idle",result.get(1,TimeUnit.SECONDS).getString("status"))
        assertNull(ControlRuntime.service)
    }
    @Test fun revokedEpochNeverDispatchesToAVirtualDisplay() {
        val epoch = sync("danger-full-access"); ControlRuntime.stop("explicit fixture stop")
        val result = call(epoch,"create"); shadowOf(Looper.getMainLooper()).idle()
        assertTrue(result.isCompletedExceptionally); assertEquals("idle",VirtualScreenController.status().getString("status"))
    }
    @Test fun noVirtualScreenDoesNotPermitCoordinatesOnTheRealDisplay() {
        val epoch = sync("danger-full-access"); val result = call(epoch,"tap"); shadowOf(Looper.getMainLooper()).idle()
        assertTrue(result.isCompletedExceptionally); assertEquals("idle",VirtualScreenController.status().getString("status"))
    }
}
