package com.dshphone

import android.app.AlertDialog
import android.app.Application
import android.content.Intent
import android.net.Uri
import android.os.Looper
import android.webkit.WebView
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowAlertDialog
import java.util.Base64

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk=[35],application=Application::class)
@LooperMode(LooperMode.Mode.PAUSED)
class PeerNativeLifecycleTest {
    private fun intent():Intent {
        val pair=JSONObject().put("version",1).put("relay","wss://desk.example.org/relay").put("room","a".repeat(32)).put("secret","b".repeat(64))
        val code=Base64.getUrlEncoder().withoutPadding().encodeToString(pair.toString().toByteArray())
        return Intent(Intent.ACTION_VIEW,Uri.parse("dsh-phone://peer/connect#dsh-peer:1:$code"))
    }
    private fun view(a:MainActivity)=MainActivity::class.java.getDeclaredField("webView").apply{isAccessible=true}.get(a) as WebView
    @Test fun coldAndHotIntentsAreConsumedOnceAndCancellationRetainsStandalonePage() {
        val initial=intent();val c=Robolectric.buildActivity(MainActivity::class.java,initial).setup();val a=c.get()
        try {
            val old=view(a).url
            assertNull(a.intent.data)
            val first=ShadowAlertDialog.getLatestAlertDialog();assertNotNull(first);assertTrue(first.isShowing)
            assertTrue(shadowOf(first).message.toString().contains("电脑 DSH"))
            first.getButton(AlertDialog.BUTTON_NEGATIVE).performClick()
            assertFalse(ComputerSelection(a).isPeer());assertEquals(old,view(a).url)
            val hot=intent();c.newIntent(hot)
            val second=ShadowAlertDialog.getLatestAlertDialog();assertNotSame(first,second);assertNull(a.intent.data)
            second.getButton(AlertDialog.BUTTON_NEGATIVE).performClick()
            c.newIntent(hot);assertSame(second,ShadowAlertDialog.getLatestAlertDialog())
            assertEquals(old,view(a).url)
        } finally {c.pause().stop().destroy()}
    }
    @Test fun invalidatedAdmissionCannotNavigateAtTheSecondUiHop() {
        val c=Robolectric.buildActivity(MainActivity::class.java).setup();val a=c.get()
        try {
            val previous=view(a).url
            var admitted=true
            val guard:()->Boolean={admitted}
            val method=MainActivity::class.java.declaredMethods.single{it.name=="switchPage"}.apply{isAccessible=true}
            if(method.parameterCount==3) method.invoke(a,true,null,guard) else method.invoke(a,true,null)
            admitted=false
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(previous,view(a).url)
            assertFalse(MainActivity::class.java.getDeclaredField("remoteMode").apply{isAccessible=true}.getBoolean(a))
        } finally {c.pause().stop().destroy()}
    }
    @Test fun destroyedActivityDismissesPendingFirstConfirmation() {
        val c=Robolectric.buildActivity(MainActivity::class.java,intent()).setup()
        val dialog=ShadowAlertDialog.getLatestAlertDialog();assertNotNull(dialog)
        c.pause().stop().destroy();assertFalse(dialog.isShowing)
    }
}
