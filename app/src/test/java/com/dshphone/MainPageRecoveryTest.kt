package com.dshphone

import android.app.Application
import android.graphics.Bitmap
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
@LooperMode(LooperMode.Mode.PAUSED)
class MainPageRecoveryTest {
    private fun view(a: MainActivity) = MainActivity::class.java.getDeclaredField("webView").apply { isAccessible=true }.get(a) as WebView
    private val detail = object : RenderProcessGoneDetail() {
        override fun didCrash() = true
        override fun rendererPriorityAtExit() = 0
    }
    private fun navigate(v: WebView, url: String) {
        v.loadUrl(url); v.webViewClient.onPageStarted(v,url,null as Bitmap?)
    }
    @Test fun rendererRecoveryReplacesOnlyWebViewAndRetainsSessionUrl() {
        val c=Robolectric.buildActivity(MainActivity::class.java).setup(); val a=c.get()
        try {
            val old=view(a); val url="http://127.0.0.1:3080/?session=fixture#chat"
            navigate(old,url)
            val before=DshService.process; val starts=DshService.restartCount
            assertTrue(old.webViewClient.onRenderProcessGone(old,detail))
            assertNotSame(old,view(a)); assertEquals(url,view(a).url)
            assertSame(before,DshService.process); assertEquals(starts,DshService.restartCount)
            assertTrue(shadowOf(old).wasDestroyCalled())
        } finally {c.pause().stop().destroy()}
    }
    @Test fun backgroundEvictionIsDeferredAndRepeatedFailureDoesNotLoop() {
        val c=Robolectric.buildActivity(MainActivity::class.java).setup();val a=c.get()
        try {
            val old=view(a); navigate(old,"http://127.0.0.1:3080/chat")
            c.pause();assertTrue(old.webViewClient.onRenderProcessGone(old,detail));assertSame(old,view(a))
            c.resume();val replacement=view(a);assertNotSame(old,replacement)
            assertTrue(replacement.webViewClient.onRenderProcessGone(replacement,detail))
            assertSame(replacement,view(a))
            c.pause().resume();assertSame(replacement,view(a))
        } finally {c.pause().stop().destroy()}
    }
    @Test fun aSuccessfullyLoadedReplacementAllowsIndependentLaterRecovery() {
        val c=Robolectric.buildActivity(MainActivity::class.java).setup();val a=c.get()
        try {
            val first=view(a); navigate(first,"http://127.0.0.1:3080/chat")
            first.webViewClient.onRenderProcessGone(first,detail)
            val second=view(a);second.webViewClient.onPageFinished(second,second.url!!)
            second.webViewClient.onRenderProcessGone(second,detail)
            assertNotSame(second,view(a))
        } finally {c.pause().stop().destroy()}
    }
}
