package com.dshphone.incoming

import org.junit.Assert.*
import org.junit.Test

class IncomingHandoffPreferencesTest {
    private class Memory : IncomingHandoffPreferences.Store {
        var value: String? = null
        var writes = 0
        var accepts = true
        override fun read() = value
        override fun write(value: String): Boolean { writes++; if (accepts) this.value = value; return accepts }
    }
    @Test fun readingDefaultDoesNotSilentlyMigrateOrSavePreference() {
        val store = Memory(); val settings = IncomingHandoffPreferences(store)
        assertEquals(IncomingHandoffMode.ATTACH_CURRENT, settings.mode())
        assertEquals(0, store.writes)
    }
    @Test fun explicitChoiceSurvivesNewWrapperAndFailedWritePreservesPreviousChoice() {
        val store = Memory(); val settings = IncomingHandoffPreferences(store)
        assertTrue(settings.select(IncomingHandoffMode.TEMPORARY_WORKSPACE))
        assertEquals(IncomingHandoffMode.TEMPORARY_WORKSPACE, IncomingHandoffPreferences(store).mode())
        store.accepts = false
        assertFalse(settings.select(IncomingHandoffMode.ATTACH_CURRENT))
        assertEquals(IncomingHandoffMode.TEMPORARY_WORKSPACE, settings.mode())
    }
}
