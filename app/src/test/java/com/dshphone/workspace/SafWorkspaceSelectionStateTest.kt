package com.dshphone.workspace

import org.junit.Assert.*
import org.junit.Test

class SafWorkspaceSelectionStateTest {
    @Test fun onlyOneRequestCanOwnSystemPickerAndClearingPermitsRetry() {
        val state = SafWorkspaceSelectionState()
        val initial = state.begin("first"); assertNotNull("first request must acquire picker", initial)
        val first = initial!!
        assertNull(state.begin("overlap"))
        assertNull(state.finish(first.code + 1))
        assertEquals("first", state.finish(first.code)?.requestId)
        val second = state.begin("second")!!
        assertNotEquals(first.code, second.code)
        assertNull(state.finish(first.code))
        assertEquals("second", state.finish(second.code)?.requestId)
    }
    @Test fun timeoutCancelAndLateResultCannotCompleteFutureRequest() {
        val state = SafWorkspaceSelectionState()
        val initial = state.begin("old"); assertNotNull("first request must acquire picker", initial)
        val old = initial!!
        assertEquals(old, state.clear())
        assertNull(state.clear())
        val current = state.begin("current")!!
        assertNull(state.finish(old.code))
        assertEquals(current, state.current)
        assertEquals(current, state.finish(current.code))
    }
    @Test fun neverReusesRequestCodesAndExhaustionFailsClosed() {
        val state = SafWorkspaceSelectionState()
        val codes = mutableSetOf<Int>()
        repeat(SafWorkspaceSelectionState.CODE_LIMIT - SafWorkspaceSelectionState.CODE_START + 1) {
            val leaseOrNull = state.begin("request-$it"); assertNotNull("request code must be available", leaseOrNull)
            val lease = leaseOrNull!!
            assertTrue(codes.add(lease.code)); state.clear()
        }
        assertNull(state.begin("exhausted")); assertNull(state.current)
    }
}
