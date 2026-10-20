package com.dshphone

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.nio.file.Files

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class BundledPackageUpgradeTest {
    @get:Rule val temp = TemporaryFolder()
    private fun pkg(base: File, version: String, name: String = "dsh-our-free-model"): File {
        val directory = File(base, "dsh-our-free-model").apply { mkdirs() }
        File(directory, "package.json").writeText(JSONObject().put("name", name).put("version", version).toString())
        File(directory, "independent-marker").writeText("preserve version $version")
        return directory
    }

    @Test fun newerIndependentReleaseIsPreservedByteForByte() {
        val bundled = temp.newFolder("bundled"); val installed = temp.newFolder("installed")
        pkg(bundled, "2.1.0"); val current = pkg(installed, "2.5.3")
        val original = File(current, "package.json").readBytes()
        assertEquals(setOf("dsh-our-free-model"), BundledPackageUpgrade.preservedPackages(bundled, installed))
        assertArrayEquals(original, File(current, "package.json").readBytes())
        assertEquals("preserve version 2.5.3", File(current, "independent-marker").readText())
    }

    @Test fun olderAndEqualVersionsAcceptTheBundledUpdateWithNumericOrdering() {
        val bundled = temp.newFolder("bundled"); val installed = temp.newFolder("installed")
        pkg(bundled, "2.10.0")
        for (version in listOf("1.99.99", "2.9.99", "2.10.0")) {
            pkg(installed, version)
            assertEquals(emptySet<String>(), BundledPackageUpgrade.preservedPackages(bundled, installed))
        }
        pkg(installed, "3.0.0")
        assertEquals(setOf("dsh-our-free-model"), BundledPackageUpgrade.preservedPackages(bundled, installed))
    }

    @Test fun freshInstallAndAbsentOptionalBundleNeedNoPreservation() {
        val bundled = temp.newFolder("bundled"); val installed = temp.newFolder("installed")
        assertTrue(BundledPackageUpgrade.preservedPackages(bundled, installed).isEmpty())
        pkg(bundled, "2.1.0")
        assertTrue(BundledPackageUpgrade.preservedPackages(bundled, installed).isEmpty())
    }

    @Test fun unknownVersionOrIdentityStopsBeforeAnyOriginalBytesChange() {
        val bundled = temp.newFolder("bundled"); val installed = temp.newFolder("installed")
        pkg(bundled, "2.1.0")
        for ((version, name) in listOf("2.6.0-beta.1" to "dsh-our-free-model", "2.5.3" to "user-replacement", "9999999999999999999999.0.0" to "dsh-our-free-model")) {
            val current = pkg(installed, version, name); val before = File(current, "package.json").readBytes()
            assertThrows(IllegalStateException::class.java) { BundledPackageUpgrade.preservedPackages(bundled, installed) }
            assertArrayEquals(before, File(current, "package.json").readBytes())
        }
    }

    @Test fun linkedAndBrokenLinkedInstallationsAreNotOverwritten() {
        val bundled = temp.newFolder("bundled"); val installed = temp.newFolder("installed")
        pkg(bundled, "2.1.0")
        val outside = temp.newFolder("outside"); val current = pkg(outside, "2.5.3")
        val target = File(installed, "dsh-our-free-model")
        Files.createSymbolicLink(target.toPath(), current.toPath())
        assertThrows(IllegalStateException::class.java) { BundledPackageUpgrade.preservedPackages(bundled, installed) }
        Files.delete(target.toPath()); Files.createSymbolicLink(target.toPath(), File(outside, "missing").toPath())
        assertThrows(IllegalStateException::class.java) { BundledPackageUpgrade.preservedPackages(bundled, installed) }
        assertEquals("preserve version 2.5.3", File(current, "independent-marker").readText())
    }
}
