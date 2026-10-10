package com.dshphone

import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** 验证生产 Activity 交给系统浏览器的 Intent，不访问授权网站。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class WorkBuddySystemBrowserTest {
    @Test
    fun officialAuthorizationOpensSystemBrowserWithOriginalState() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).get()
        val url = "https://www.workbuddy.ai/login?platform=workbuddy-ai&state=sample&version=5.5.2&loginSessionId=session"
        val method = MainActivity::class.java.getDeclaredMethod("openWorkBuddyBrowser", Uri::class.java)
        method.isAccessible = true
        method.invoke(activity, Uri.parse(url))
        val intent = shadowOf(activity).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals(url, intent.data.toString())
        assertFalse(intent.hasExtra("state"))
    }
}
