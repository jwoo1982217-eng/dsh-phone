package com.dshphone.browser
import android.app.Application
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
@RunWith(RobolectricTestRunner::class)
@Config(sdk=[35],application=Application::class)
class BrowserServiceProfileTest {
    @Test fun profileTabsRemainOwnerScopedAndInvalidInputDoesNotCreateAnotherTab() {
        val controller=Robolectric.buildService(BrowserService::class.java).create()
        val service=controller.get()
        try {
            service.call("a","open",JSONObject().put("url","https://example.invalid/").put("viewportWidth",412).put("viewportHeight",915)) { _,_-> }
            val rows=service.status("a").getJSONArray("tabs");assertEquals(1,rows.length())
            val first=rows.getJSONObject(0);val id=first.getString("id")
            assertEquals(412,first.getInt("viewportWidth"));assertEquals(915,first.getInt("viewportHeight"))
            assertTrue(first.isNull("viewportObserved"))
            assertEquals(0,service.status("b").getJSONArray("tabs").length())
            assertNull(service.view("b",id))
            try { service.select("b",id);fail("foreign tab") } catch(expected:IllegalStateException) {}
            try { service.call("a","open",JSONObject().put("url","https://example.invalid/").put("viewportWidth",-1)) { _,_-> };fail("invalid width") } catch(expected:IllegalArgumentException) {}
            assertEquals(1,service.status("a").getJSONArray("tabs").length())
            service.call("a","profile",JSONObject().put("tabId",id).put("viewportWidth",820).put("viewportHeight",1180)) { _,_-> }
            val next=service.status("a").getJSONArray("tabs").getJSONObject(0)
            assertEquals(id,next.getString("id"));assertEquals(820,next.getInt("viewportWidth"));assertEquals(1180,next.getInt("viewportHeight"))
            service.call("a","close",JSONObject().put("tabId",id)) { _,_-> }
            assertEquals(0,service.status("a").getJSONArray("tabs").length())
        } finally { controller.destroy() }
    }
    @Test fun viewportAndUaChangesAreExplicitAndUntrustedSchemesNeverOpen() {
        val controller=Robolectric.buildService(BrowserService::class.java).create();val service=controller.get()
        try {
            for(url in listOf("file:///sdcard/secret","content://fixture/a","javascript:alert(1)","https://a:b@example.invalid/")) {
                try { service.call("a","open",JSONObject().put("url",url)) { _,_-> };fail(url) } catch(expected:IllegalArgumentException) {}
            }
            assertEquals(0,service.status("a").getJSONArray("tabs").length())
        } finally { controller.destroy() }
    }
    @Test fun repeatingCurrentProfileKeepsTheExistingPageAndExplicitReloadStillWorks() {
        val controller=Robolectric.buildService(BrowserService::class.java).create();val service=controller.get()
        try {
            service.call("a","open",JSONObject().put("url","https://example.invalid/").put("viewportWidth",412).put("viewportHeight",915)) { _,_-> }
            val id=service.status("a").getString("active")
            val original=service.view("a",id)!!
            var completed=false
            service.call("a","profile",JSONObject().put("tabId",id).put("viewportWidth",412).put("viewportHeight",915).put("identity","android-real")) { value,error->
                assertNull(error);assertEquals(id,value!!.getString("active"));completed=true
            }
            assertSame("Unchanged viewport must keep the live page",original,service.view("a",id))
            assertTrue("An unchanged profile must not await another page load",completed)
            service.call("a","profile",JSONObject().put("tabId",id)) { _,error->assertNull(error) }
            assertSame(original,service.view("a",id))
            try { service.call("a","profile",JSONObject().put("tabId",id).put("viewportWidth",239)) { _,_-> };fail("invalid width") } catch(expected:IllegalArgumentException) {}
            assertSame(original,service.view("a",id))
            service.call("a","reload",JSONObject().put("tabId",id)) { _,_-> }
            assertSame(original,service.view("a",id))
            service.call("a","profile",JSONObject().put("tabId",id).put("viewportWidth",820).put("viewportHeight",1180)) { _,_-> }
            assertNotSame("A real profile change still applies",original,service.view("a",id))
        } finally { controller.destroy() }
    }
}
