package com.dshphone.incoming

import android.content.SharedPreferences
import java.lang.reflect.Proxy
import org.junit.Assert.*
import org.junit.Test

class AndroidIncomingPreferenceStoreTest {
    private class Fixture {
        var value: String? = null
        var failNext = false
        val preferences = Proxy.newProxyInstance(SharedPreferences::class.java.classLoader, arrayOf(SharedPreferences::class.java)) { _, method, args ->
            when (method.name) {
                "getString" -> value ?: args?.get(1)
                "edit" -> editor()
                else -> throw AssertionError("Unexpected preferences call: ${method.name}")
            }
        } as SharedPreferences
        private fun editor(): SharedPreferences.Editor {
            var replacement = value
            lateinit var proxy: SharedPreferences.Editor
            proxy = Proxy.newProxyInstance(SharedPreferences.Editor::class.java.classLoader, arrayOf(SharedPreferences.Editor::class.java)) { _, method, args ->
                when (method.name) {
                    "putString" -> { replacement = args?.get(1) as String?; proxy }
                    "remove" -> { replacement = null; proxy }
                    "commit" -> { value = replacement; if (failNext) { failNext = false; false } else true }
                    else -> throw AssertionError("Unexpected editor call: ${method.name}")
                }
            } as SharedPreferences.Editor
            return proxy
        }
    }
    @Test fun androidCommitFailureDoesNotLeaveFailedChoiceInProcessMemory() {
        val fixture = Fixture()
        val store = AndroidIncomingPreferenceStore(fixture.preferences)
        assertTrue(store.write("temporary-workspace"))
        fixture.failNext = true
        assertFalse(store.write("attach-current"))
        assertEquals("temporary-workspace", store.read())
    }
    @Test fun failedFirstSaveRestoresUnsetDefaultWithoutMigratingIt() {
        val fixture = Fixture(); fixture.failNext = true
        val store = AndroidIncomingPreferenceStore(fixture.preferences)
        assertFalse(store.write("temporary-workspace"))
        assertNull(store.read())
        assertEquals(IncomingHandoffMode.ATTACH_CURRENT, IncomingHandoffMode.fromStored(store.read()))
    }
}
