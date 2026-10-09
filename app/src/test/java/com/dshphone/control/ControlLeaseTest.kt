package com.dshphone.control

import org.junit.Assert.*
import org.junit.Test

class ControlLeaseTest {
    private var time = 100L
    private val lease = ControlLease({ time }, { it == "com.dshphone" || it == "com.android.settings" })
    private fun request(owner: String = "session-a", minutes: Int = 1) = lease.request(owner, "搜索天气", setOf("com.example.browser"), minutes)
    private fun reject(block: () -> Unit) { try { block(); fail("must reject") } catch (_: IllegalStateException) {} }
    @Test fun pendingNeverGrantsPermission() { request(); reject { lease.check("session-a") }; assertNull(lease.current()) }
    @Test fun exactNativeApprovalGrantsOnlyOwnerAndApp() {
        val grant = lease.approve(request().id); assertEquals("session-a", grant.owner)
        assertEquals(grant, lease.check("session-a", "com.example.browser", grant.epoch))
        reject { lease.check("session-b", "com.example.browser") }; reject { lease.check("session-a", "com.other.app") }
    }
    @Test fun expiryIsInclusiveAndCannotBeRevivedByClockReset() {
        lease.approve(request().id); time = 60_100; assertNull(lease.current()); time = 10; assertNull(lease.current())
    }
    @Test fun stopInvalidatesAnOutstandingEpochAndPendingRequest() {
        val grant = lease.approve(request().id); lease.stop(); assertNull(lease.current()); assertNull(lease.currentRequest())
        val next = lease.approve(request().id); assertTrue(next.epoch > grant.epoch); reject { lease.check("session-a", expectedEpoch = grant.epoch) }
    }
    @Test fun staleApprovalCannotApproveAReplacement() { val first = request(); lease.stop(); request("session-b"); reject { lease.approve(first.id) } }
    @Test fun requestExpiryAndDuplicateRequestsAreBounded() {
        val first = request(); assertEquals(first, request()); time = first.deadline; reject { lease.approve(first.id) }; assertNull(lease.currentRequest())
    }
    @Test fun anotherPendingRequestCannotSilentlyReplaceTheDisplayedOne() { request(); reject { request("session-b") }; assertEquals("session-a", lease.currentRequest()!!.owner) }
    @Test fun aNewGrantRequiresASeparateHumanApproval() {
        val first = lease.approve(request().id); val second = request("session-b")
        assertEquals(first, lease.current()); val next = lease.approve(second.id); reject { lease.check("session-a") }; assertEquals(next, lease.check("session-b"))
    }
    @Test fun invalidRangesAndProtectedAppsAreRejected() {
        for (minutes in listOf(0, 31)) try { request(minutes = minutes); fail() } catch (_: IllegalArgumentException) {}
        for (target in listOf("com.dshphone", "com.android.settings", "bad/pkg")) try { lease.request("session-a", "task", setOf(target), 1); fail() } catch (_: IllegalArgumentException) {}
        try { lease.request("qq-dm-123", "task", setOf("com.example.app"), 1); fail() } catch (_: IllegalArgumentException) {}
    }
    @Test fun reconstructionStartsOff() { lease.approve(request().id); val restarted = ControlLease({ time }, { false }); assertNull(restarted.current()); reject { restarted.check("session-a") } }
    @Test fun risksRequireApprovalWhileKnownNavigationDoesNot() {
        for (label in listOf("发送", "删除", "支付", "确认", "send", "Purchase", "没有明确用途的按钮", "", "搜索并发送")) assertTrue(label, ControlRisk.needsConfirmation("click", label))
        for (label in listOf("搜索", "返回", "菜单", "Search", "back")) assertFalse(label, ControlRisk.needsConfirmation("click", label))
        assertTrue(ControlRisk.needsConfirmation("tap", "搜索")); assertTrue(ControlRisk.needsConfirmation("swipe", ""))
    }
    @Test fun sessionFullModeAllowsOtherAppsUntilStopAndInvalidatesOldEpoch() {
        val first = lease.claim("session-a", "danger-full-access")
        time = 100_000_000; assertEquals(first, lease.check("session-a", "com.other.app")); assertTrue(first.continuous)
        lease.stop(); assertNull(lease.current()); reject { lease.check("session-a", expectedEpoch = first.epoch) }
        val next = lease.claim("session-a", "read-only"); assertFalse(next.continuous); assertTrue(next.epoch > first.epoch)
        reject { lease.check("session-a", "com.android.settings") }
    }
    @Test fun cloudCannotInheritASelectedSessionModeButKeepsHumanApprovedTaskMode() {
        try { lease.claim("cloud-fixture", "danger-full-access"); fail() } catch (_: IllegalArgumentException) {}
        assertFalse(lease.approve(request("cloud-fixture").id).continuous)
    }
    @Test fun unknownPermissionModeCannotBecomeFullAccess() {
        try { lease.claim("session-a", "invalid"); fail() } catch (_: IllegalArgumentException) {}
        assertNull(lease.current())
    }
}
