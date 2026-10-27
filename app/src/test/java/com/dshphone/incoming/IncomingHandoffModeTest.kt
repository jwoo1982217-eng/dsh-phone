package com.dshphone.incoming

import org.junit.Assert.*
import org.junit.Test

class IncomingHandoffModeTest {
    @Test fun unsetOrUnrecognizedSettingPreservesExistingAttachCurrentBehavior() {
        for (value in listOf(null, "", "unknown", "new", "temporary-workspace "))
            assertEquals(IncomingHandoffMode.ATTACH_CURRENT, IncomingHandoffMode.fromStored(value))
    }
    @Test fun temporaryWorkspaceIsAnExplicitStableChoiceNotAnAutomaticMigration() {
        assertEquals(IncomingHandoffMode.TEMPORARY_WORKSPACE, IncomingHandoffMode.fromStored("temporary-workspace"))
        assertEquals("attach-current", IncomingHandoffMode.ATTACH_CURRENT.stored)
        assertEquals("temporary-workspace", IncomingHandoffMode.TEMPORARY_WORKSPACE.stored)
    }
}
