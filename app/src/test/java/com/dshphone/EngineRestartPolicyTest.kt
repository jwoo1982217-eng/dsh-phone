package com.dshphone

import org.junit.Assert.*
import org.junit.Test

class EngineRestartPolicyTest {
    @Test fun repeatedCrashesBackOffAndStopWithoutUnlimitedRestarts() {
        val policy = EngineRestartPolicy()
        assertEquals(listOf(5000L,10000L,20000L,40000L,80000L,80000L), (1..6).map { policy.failed() })
        repeat(5) { assertEquals(80000L, policy.failed()) }
        assertNull(policy.failed()); assertTrue(policy.paused)
        repeat(100) { assertNull(policy.failed()) }
    }
    @Test fun liveSlowProcessIsNeverAReasonForDestructiveRestart() {
        val policy = EngineRestartPolicy()
        repeat(3) { policy.failed() }
        policy.started(1000)
        policy.alive(1001); assertEquals(40000L, policy.failed())
    }
    @Test fun stableProcessOrExplicitUserRetryResetsCircuit() {
        val policy = EngineRestartPolicy()
        repeat(4) { policy.failed() }; policy.started(1000)
        policy.alive(121000); assertEquals(5000L, policy.failed())
        repeat(12) { policy.failed() }; policy.userRetry()
        assertFalse(policy.paused); assertEquals(5000L, policy.failed())
    }
}
