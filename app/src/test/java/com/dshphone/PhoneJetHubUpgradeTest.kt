package com.dshphone

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[35],manifest=Config.NONE)
class PhoneJetHubUpgradeTest {
    private fun setup():Triple<File,File,File> {
        val root=Files.createTempDirectory("JetHub 定向升级 ").toFile();val files=File(root,"files").apply{mkdirs()}
        File(files,"dsh.version").writeText("117")
        for(p in listOf("tree/node_modules/dsh-codearts-auth","dsh-home/profiles/phone/node_modules/dsh-codearts-auth")) {
            val d=File(files,p).apply{mkdirs()};File(d,"package.json").writeText("""{"name":"dsh-codearts-auth","version":"old"}""")
            File(d,"old.js").writeText("old-$p")
        }
        val tree=File(root,"stage-tree");val home=File(root,"stage-home")
        for(d in listOf(File(tree,"node_modules/dsh-codearts-auth"),File(home,"profiles/phone/node_modules/dsh-codearts-auth"))) {
            d.mkdirs();File(d,"package.json").writeText("""{"name":"dsh-providers-hub","version":"0.2.1-rc.2"}""");File(d,"new.js").writeText("new")
        }
        File(files,"tree/custom-user-tool.js").writeText("keep custom code")
        File(files,"dsh-home/credentials-test.txt").writeText("keep data")
        return Triple(files,tree,home)
    }
    @Test fun onlyHubPackagesChangeAndCustomTreeCodeAndUserDataRemain() {
        val(f,t,h)=setup();PhoneJetHubUpgrade.install(f,t,h)
        assertEquals("119",File(f,"dsh.version").readText())
        assertEquals("keep custom code",File(f,"tree/custom-user-tool.js").readText())
        assertEquals("keep data",File(f,"dsh-home/credentials-test.txt").readText())
        PhoneJetHubUpgrade.recover(f)
        assertTrue(File(f,"tree/node_modules/dsh-codearts-auth/new.js").isFile)
    }
    @Test fun interruptedPublicationRestoresProgramsAndKeepsConcurrentUserData() {
        val(f,t,h)=setup();val old=PhoneJetHubUpgrade.fingerprint(File(f,"tree/node_modules/dsh-codearts-auth"))
        assertTrue(runCatching { PhoneJetHubUpgrade.install(f,t,h) {
            File(f,"dsh-home/new-user-message.txt").writeText("new data")
            error("simulated interruption")
        } }.isFailure)
        PhoneJetHubUpgrade.recover(f);PhoneJetHubUpgrade.recover(f)
        assertEquals("117",File(f,"dsh.version").readText())
        assertEquals(old,PhoneJetHubUpgrade.fingerprint(File(f,"tree/node_modules/dsh-codearts-auth")))
        assertEquals("new data",File(f,"dsh-home/new-user-message.txt").readText())
        assertFalse(File(f,"tree/node_modules/dsh-providers-hub").exists())
    }
    @Test fun concurrentCodeChangeRejectsRollbackWithoutDiscardingTheNewEdit() {
        val(f,t,h)=setup()
        assertTrue(runCatching { PhoneJetHubUpgrade.install(f,t,h) { error("interrupt") } }.isFailure)
        File(f,"tree/node_modules/dsh-codearts-auth/user-edit.js").writeText("keep edit")
        assertTrue(runCatching { PhoneJetHubUpgrade.recover(f) }.isFailure)
        assertEquals("keep edit",File(f,"tree/node_modules/dsh-codearts-auth/user-edit.js").readText())
    }
    @Test fun destinationConflictIsRefusedBeforeAnyProgramMove() {
        val(f,t,h)=setup();val conflict=File(f,"dsh-home/profiles/phone/node_modules/dsh-providers-hub").apply{mkdirs()}
        File(conflict,"user.txt").writeText("keep")
        assertTrue(runCatching { PhoneJetHubUpgrade.install(f,t,h) }.isFailure)
        assertEquals("117",File(f,"dsh.version").readText())
        assertTrue(File(f,"tree/node_modules/dsh-codearts-auth/old.js").isFile)
    }
}
