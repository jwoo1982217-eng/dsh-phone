package com.dshphone

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class PhoneJetHubAliasTest {
    private fun root() = Files.createTempDirectory("jethub-名称 空格-").toFile()
    private fun install(root: File, current: Boolean = true): List<File> {
        return listOf("tree/node_modules", "dsh-home/profiles/phone/node_modules").map {
            val modules = File(root, it).apply { mkdirs() }
            File(modules, "dsh-codearts-auth").mkdirs()
            File(modules, "dsh-codearts-auth/package.json").writeText(
                """{"name":"${if (current) "dsh-providers-hub" else "dsh-codearts-auth"}","version":"test"}""")
            modules
        }
    }
    @Test fun namesResolveToOnePhysicalPackageAndRepeatedPreparationIsSafe() {
        val root = root(); val modules = install(root)
        PhoneJetHubAlias.prepare(root); PhoneJetHubAlias.prepare(root)
        for (dir in modules) assertEquals(File(dir,"dsh-codearts-auth").canonicalFile,
            File(dir,"dsh-providers-hub").canonicalFile)
    }
    @Test fun independentSameNameIsRejectedBeforeWritingEitherAliasAndRecoveryCanRetry() {
        val root=root(); val modules=install(root)
        val conflict=File(modules[1],"dsh-providers-hub").apply{mkdirs()}
        File(conflict,"user.txt").writeText("keep")
        assertTrue(runCatching { PhoneJetHubAlias.prepare(root) }.isFailure)
        assertFalse(Files.exists(File(modules[0],"dsh-providers-hub").toPath(),java.nio.file.LinkOption.NOFOLLOW_LINKS))
        assertEquals("keep",File(conflict,"user.txt").readText())
        File(conflict,"user.txt").delete(); conflict.delete()
        PhoneJetHubAlias.prepare(root)
        assertTrue(Files.isSymbolicLink(File(modules[0],"dsh-providers-hub").toPath()))
    }
    @Test fun unrelatedAndBrokenSymlinksAreRejectedWithoutTouchingTheirTargets() {
        val root=root();val modules=install(root)
        Files.createSymbolicLink(File(modules[0],"dsh-providers-hub").toPath(),File("unrelated").toPath())
        assertTrue(runCatching { PhoneJetHubAlias.preflight(root) }.isFailure)
        assertEquals("unrelated",Files.readSymbolicLink(File(modules[0],"dsh-providers-hub").toPath()).toString())
    }
    @Test fun olderUnrenamedPackageDoesNotGainANewRegistration() {
        val root=root();val modules=install(root,false)
        PhoneJetHubAlias.prepare(root)
        for(dir in modules) assertFalse(Files.exists(File(dir,"dsh-providers-hub").toPath(),java.nio.file.LinkOption.NOFOLLOW_LINKS))
    }
}
