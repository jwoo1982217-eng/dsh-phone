package com.dshphone

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.net.Uri
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.util.Base64

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
@LooperMode(LooperMode.Mode.PAUSED)
class PeerConnectionTest {
    private val relay = "wss://desk.example.org/relay"
    private fun code(relay: String = this.relay, room: String = "a".repeat(32), secret: String = "b".repeat(64)): String =
        "dsh-peer:1:" + Base64.getUrlEncoder().withoutPadding().encodeToString(JSONObject()
            .put("version",1).put("relay",relay).put("room",room).put("secret",secret).toString().toByteArray())
    private fun link(relay: String = this.relay) = "dsh-phone://peer/connect#${code(relay)}"

    @Test fun strictParserAcceptsV1AndBoundHttpsBridge() {
        assertEquals(code(), PeerLink.parse(link())?.code)
        assertEquals(code(), PeerLink.parse("https://desk.example.org/connect#${code()}")?.code)
        assertEquals("desk.example.org", PeerLink.parse(link())?.relayHost)
        assertFalse(PeerLink.parse(link()).toString().contains("bbbbbbbb"))
    }
    @Test fun parserRejectsMalformedOrMisboundCapabilities() {
        val bad = listOf(link().replace("peer/connect","peer/wrong"), link().replace("peer/connect","peer:123/connect"),
            link().replace("peer/connect","user@peer/connect"), link().replace("#","?x=1#"),
            "https://evil.example.org/connect#${code()}", "https://desk.example.org/connect?x=1#${code()}",
            link("ws://external.example.org/relay"), link("wss://user@desk.example.org/relay"),
            link("wss://desk.example.org/relay?secret=x"), link("wss://desk.example.org/relay#x"),
            "dsh-phone://peer/connect#${code(room="g".repeat(32))}", "dsh-phone://peer/connect#${code(secret="b".repeat(63))}",
            "dsh-phone://peer/connect#dsh-peer:1:@@@@", "dsh-phone://peer/connect#dsh-peer:1:e30",
            link()+"=", link()+"x".repeat(2048), link().replace("#","#%64"))
        bad.forEach { assertNull(it.take(60), PeerLink.parse(it)) }
    }
    @Test fun parserRequiresActualJsonAndRejectsDuplicateKeys() {
        val json = JSONObject().put("version",1).put("relay",relay).put("room","a".repeat(32)).put("secret","b".repeat(64)).toString()
        listOf(json.replace("\"version\"", "version"), json.replace("\"", "'"), json.replace("{", "{\"version\":1," )).forEach { bad ->
            val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(bad.toByteArray())
            assertNull(PeerLink.parse("dsh-phone://peer/connect#dsh-peer:1:$encoded"))
        }
    }
    private class Host : PeerHost {
        val background = ArrayDeque<() -> Unit>(); val ui = ArrayDeque<() -> Unit>()
        val confirmations = mutableListOf<(Boolean) -> Unit>(); val actions = mutableListOf<String>()
        var starts=0;var navigations=0;var choices=0;var saved="pocket";var readyAfter=0;var probes=0;var clock=0L;var viewing=false
        var status = PeerStatus(true,false)
        var canConnect = true
        override fun confirm(host:String, answer:(Boolean)->Unit) { confirmations.add(answer) }
        override fun background(job:()->Unit) { background.add(job) }
        override fun ui(job:()->Unit) { ui.add(job) }
        override fun start() { starts++ }
        override fun ready():Boolean = probes++ >= readyAfter
        override fun now()=clock
        override fun pause(ms:Long) { clock+=ms }
        override fun manage(action:String,code:String?):PeerStatus { actions.add(action);if(canConnect && action in listOf("pair","reconnect")) status=PeerStatus(true,true);return status }
        override fun selectPeer() { saved="peer" }
        override fun navigate(admitted:()->Boolean) { if(admitted()) navigations++ }
        override fun viewingPeer()=viewing
        override fun message(text:String) {}
        override fun choices() { choices++ }
        fun drain() { while(background.isNotEmpty()) background.removeFirst()();while(ui.isNotEmpty()) ui.removeFirst()() }
    }
    @Test fun cancellationAndInvalidInputRetainChoiceWithoutStartingAnything() {
        val h=Host();val c=PeerController(h)
        c.accept(link());assertEquals(1,h.confirmations.size);assertEquals(0,h.starts)
        h.confirmations.single()(false);h.drain()
        assertFalse(c.accept("dsh-phone://peer/connect#bad"));h.drain()
        assertEquals("pocket",h.saved);assertEquals(0,h.starts);assertTrue(h.actions.isEmpty());assertEquals(0,h.navigations)
    }
    @Test fun confirmationIsTerminalAndDuplicateCompletionCannotStartAnotherPair() {
        val canceled=Host();val first=PeerController(canceled)
        first.accept(link());canceled.confirmations.single()(false);canceled.confirmations.single()(true);canceled.drain()
        assertTrue(canceled.actions.isEmpty())
        val accepted=Host();val second=PeerController(accepted)
        second.accept(link());accepted.confirmations.single()(true);accepted.confirmations.single()(true);accepted.drain()
        assertEquals(listOf("pair"),accepted.actions);assertEquals(1,accepted.navigations)
    }
    @Test fun admittedButOfflinePeerIsRememberedWithoutLandingOnStaticOfflinePage() {
        val h=Host().apply{canConnect=false};val c=PeerController(h)
        c.accept(link());h.confirmations.single()(true);h.drain()
        assertEquals("peer",h.saved);assertEquals(0,h.navigations)
        assertTrue(h.clock in 15_000..20_000)
        h.canConnect=true;c.open();h.drain();assertEquals(1,h.navigations)
    }
    @Test fun coldAndHotLinksRequireConfirmationThenReadinessBeforePairing() {
        for (delay in listOf(0,3)) {
            val h=Host().apply{readyAfter=delay};val c=PeerController(h)
            assertTrue(c.accept(link()));h.confirmations.single()(true)
            assertTrue(h.actions.isEmpty());h.drain()
            assertEquals(1,h.starts);assertEquals(listOf("pair"),h.actions);assertEquals("peer",h.saved);assertEquals(1,h.navigations)
            assertTrue(h.probes>delay)
        }
    }
    @Test fun failedReadinessDoesNotPersistOrNavigateAndCanRetry() {
        val h=Host().apply{readyAfter=10000};val c=PeerController(h)
        c.accept(link());h.confirmations.single()(true);h.drain()
        assertEquals("pocket",h.saved);assertTrue(h.actions.isEmpty());assertEquals(0,h.navigations)
        h.readyAfter=0;c.open();h.drain();assertEquals(listOf("status","reconnect"),h.actions);assertEquals(1,h.navigations)
    }
    @Test fun destroyedOrSupersededCallbacksNeverPairOrNavigate() {
        val h=Host();val c=PeerController(h)
        c.accept(link());c.accept(link("wss://new.example.org/relay"));h.confirmations[0](true);h.drain()
        assertTrue(h.actions.isEmpty());h.confirmations[1](true);c.close();h.drain();assertEquals(0,h.navigations);assertTrue(h.actions.isEmpty())
    }
    @Test fun lateCompletionCannotSelectOrNavigateAfterUserLeavesPeer() {
        val h=Host();val c=PeerController(h)
        c.open();h.background.removeFirst()();c.leave();h.drain()
        assertEquals(0,h.navigations);assertEquals("pocket",h.saved)
    }
    @Test fun recoveryIsDeduplicatedOnlyInPeerAndNeverNavigatesHealthyPage() {
        val h=Host().apply{viewing=true;status=PeerStatus(true,true)};val c=PeerController(h)
        c.recover();c.recover();h.drain();assertEquals(listOf("status"),h.actions);assertEquals(0,h.navigations)
        c.recover();h.drain();assertEquals(1,h.actions.size)
        h.clock+=16000;h.status=PeerStatus(true,false);c.recover();c.recover();h.drain()
        assertEquals(listOf("status","status","reconnect"),h.actions);assertEquals(0,h.navigations)
        h.viewing=false;h.clock+=16000;c.recover();h.drain();assertEquals(3,h.actions.size)
    }
    @Test fun explicitOpenUsesSavedBackendPairAndNoPairShowsExistingConnections() {
        val h=Host();val c=PeerController(h);c.open();h.drain()
        assertEquals(listOf("status","reconnect"),h.actions);assertEquals(1,h.navigations)
        h.status=PeerStatus(false,false);c.open();h.drain();assertEquals(1,h.choices)
    }
    @Test fun pocketConnectionReselectsPocketAndPeerSelectionBeatsStalePocketUrl() {
        val a=Robolectric.buildActivity(Activity::class.java).setup().get()
        val selected=ComputerSelection(a);selected.pocket()
        var peers=0;var pockets=0
        val p=PocketConnection(a,{pockets++},{},{peers++})
        assertTrue(p.connect("https://old.example.org/"));selected.peer()
        p.openComputer();assertEquals(1,peers);assertEquals(1,pockets)
        assertTrue(p.connect("https://new.example.org/"));p.openComputer()
        assertEquals(1,peers);assertEquals(3,pockets);assertFalse(selected.isPeer())
        assertFalse(a.getSharedPreferences("computer-connection",0).all.toString().contains("dsh-peer:"))
    }
    @Test fun externalViewIntentResolvesOnlyIntendedCustomRoute() {
        val a=Robolectric.buildActivity(Activity::class.java).setup().get()
        val good=Intent(Intent.ACTION_VIEW,Uri.parse(link())).addCategory(Intent.CATEGORY_BROWSABLE)
        assertTrue(a.packageManager.queryIntentActivities(good,0).any { it.activityInfo.name.endsWith("MainActivity") })
        val wrong=Intent(Intent.ACTION_VIEW,Uri.parse("dsh-phone://peer/wrong#${code()}")).addCategory(Intent.CATEGORY_BROWSABLE)
        assertFalse(a.packageManager.queryIntentActivities(wrong,0).any { it.activityInfo.name.endsWith("MainActivity") })
    }
}
