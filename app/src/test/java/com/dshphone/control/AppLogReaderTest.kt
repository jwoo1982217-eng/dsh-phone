package com.dshphone.control

import org.junit.Assert.*
import org.junit.Test

class AppLogReaderTest {
    @Test fun onlySelectedUidAndBoundedReadOnlyBuffersAreRequested() {
        val command = AppLogReader.command(10298, 1000)
        assertTrue(command.contains("--uid=10298")); assertTrue(command.contains("-d")); assertFalse(command.contains("-c")); assertFalse(command.contains("sh"))
        for (uid in listOf(-1, 0, 1000, 9999)) try { AppLogReader.command(uid, 1); fail() } catch (_: IllegalArgumentException) {}
        for (lines in listOf(0, 1001)) try { AppLogReader.command(10298, lines); fail() } catch (_: IllegalArgumentException) {}
    }
    @Test fun diagnosticsKeepUsefulTextWhileCommonCredentialsAreHidden() {
        val value = AppLogReader.redact("E App: crash at Reader.open:42\nAuthorization: Bearer secret-value\napi_key=private-key\ncookie=session-value\n")
        assertTrue(value.contains("crash at Reader.open:42")); for (secret in listOf("secret-value", "private-key", "session-value")) assertFalse(value.contains(secret))
    }
}
