package com.dshphone.workspace

import org.junit.Assert.*
import org.junit.Test

class SafWorkspacePathPolicyTest {
    private val volumes = listOf(
        SafWorkspacePathPolicy.Volume("primary", "/storage/emulated/10", true),
        SafWorkspacePathPolicy.Volume("ABCD-1234", "/storage/ABCD-1234", true),
        SafWorkspacePathPolicy.Volume("FFFF-0000", "/storage/FFFF-0000", false))
    private fun path(id: String, authority: String = "com.android.externalstorage.documents") =
        SafWorkspacePathPolicy.resolve(authority, id, volumes)?.path

    @Test fun mapsSelectedPrimaryPathForActualAndroidUser() {
        assertEquals("/storage/emulated/10/Documents/项目 空格", path("primary:Documents/项目 空格"))
    }
    @Test fun usesMountedRemovableVolumeInventoryNotGuessedStoragePaths() {
        assertEquals("/storage/ABCD-1234/work", path("abcd-1234:work"))
        assertNull(path("FFFF-0000:work")); assertNull(path("DEAD-BEEF:work"))
    }
    @Test fun permitsUserSelectableVolumeRootWithoutAppendingFakeDirectory() {
        assertEquals("/storage/ABCD-1234", path("ABCD-1234:"))
    }
    @Test fun doesNotPresentCloudOrDownloadProviderUriAsFilesystemPath() {
        assertNull(path("primary:Documents", "cloud.provider.documents"))
        assertNull(path("raw:/storage/emulated/10/Download", "com.android.providers.downloads.documents"))
    }
    @Test fun rejectsTraversalAbsoluteAndAmbiguousDocumentIds() {
        for (id in listOf("primary:../outside", "primary:a/../b", "primary:/absolute", "primary:a//b",
            "primary:a/./b", "primary:a/", "primary:a\\b", "primary:a\u0000b", "primary", ":folder")) {
            assertNull(id, path(id))
        }
    }
    @Test fun percentNamedDirectoriesAreNotDoubleDecodedAndUnicodeIsPreserved() {
        assertEquals("/storage/emulated/10/%2e%2e/文档", path("primary:%2e%2e/文档"))
    }
    @Test fun refusesAmbiguousVolumeIdsAndUntrustedVolumeRoots() {
        val duplicate = volumes + SafWorkspacePathPolicy.Volume("PRIMARY", "/other", true)
        assertNull(SafWorkspacePathPolicy.resolve("com.android.externalstorage.documents", "primary:folder", duplicate))
        for (root in listOf("relative", "/storage/../data", "/storage//card", "/")) {
            assertNull(SafWorkspacePathPolicy.resolve("com.android.externalstorage.documents", "primary:x",
                listOf(SafWorkspacePathPolicy.Volume("primary", root, true))))
        }
    }
}
