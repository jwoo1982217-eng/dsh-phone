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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class EacSystemBrowserTest {
    @Test fun authorizationIntentPreservesThePhoneLink() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).get()
        val url = "https://ourfreemodel.beichenapi.com/eac/auth/github/start?link=abcdefghijklmnop_1234567"
        val method = MainActivity::class.java.getDeclaredMethod("openEacBrowser", Uri::class.java)
        method.isAccessible = true
        method.invoke(activity, Uri.parse(url))
        val intent = shadowOf(activity).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals(url, intent.data.toString())
        assertFalse(intent.hasExtra("token"))
    }
}
