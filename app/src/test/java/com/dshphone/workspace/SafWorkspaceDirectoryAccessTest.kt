package com.dshphone.workspace

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files

class SafWorkspaceDirectoryAccessTest {
    @get:Rule val temp = TemporaryFolder()
    @Test fun localDirectoryIsCheckedWithoutWritingOrCreatingFiles() {
        val root = temp.newFolder("volume")
        val chosen = File(root, "项目 空格").also { assertTrue(it.mkdir()) }
        assertTrue(SafWorkspaceDirectoryAccess.usable(SafWorkspacePathPolicy.Resolved(chosen.path, root.path)))
        assertEquals(0, chosen.list()!!.size)
        assertFalse(SafWorkspaceDirectoryAccess.usable(SafWorkspacePathPolicy.Resolved(File(root, "missing").path, root.path)))
    }
    @Test fun ordinaryFileAndSymlinkEscapingSelectedVolumeAreNotDirectories() {
        val root = temp.newFolder("volume")
        val file = File(root, "document").also { it.writeText("fixture") }
        val outside = temp.newFolder("outside")
        val link = File(root, "link")
        Files.createSymbolicLink(link.toPath(), outside.toPath())
        assertFalse(SafWorkspaceDirectoryAccess.usable(SafWorkspacePathPolicy.Resolved(file.path, root.path)))
        assertFalse(SafWorkspaceDirectoryAccess.usable(SafWorkspacePathPolicy.Resolved(link.path, root.path)))
        assertTrue(outside.exists())
    }
}
