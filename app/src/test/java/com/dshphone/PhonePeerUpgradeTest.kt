package com.dshphone

import android.app.Application
import android.content.ContextWrapper
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.nio.file.Files

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class PhonePeerUpgradeTest {
    private lateinit var root: File
    private val bases = listOf("tree/node_modules/dsh-peer", "dsh-home/profiles/phone/node_modules/dsh-peer")
    private val names = listOf("index.mjs","tunnel.mjs","relay.mjs","page.html","protocol.mjs","remote-service.mjs","transport-proxy.mjs")
    private fun old(name: String): ByteArray? = javaClass.getResourceAsStream("/remote-peer-old/$name")?.use { it.readBytes() }
    private fun next() = names.associateWith { "updated program $it".toByteArray() }
    private fun manifest(data: Map<String,ByteArray> = next()): String = JSONObject().put("version",1).put("targetVersion","122").put("sdk","0.2.1-alpha.1")
        .put("files",JSONArray().apply { data.forEach { (name,bytes) -> put(JSONObject().put("name",name).put("oldSha256",old(name)?.let(PhoneCompactionUpgrade::digest) ?: JSONObject.NULL)
            .put("sha256",PhoneCompactionUpgrade.digest(bytes)).put("bytes",bytes.size)) } }).toString()
    private fun put(path:String,bytes:ByteArray)=File(root,path).apply { parentFile!!.mkdirs();writeBytes(bytes) }
    private fun put(path:String,text:String)=put(path,text.toByteArray())
    private fun protected()=listOf("dsh-home/extensions/中文 空格工具/main.mjs","dsh-home/skills/user/SKILL.md","dsh-home/storage/session.jsonl",
        "dsh-home/credentials.json","dsh-home/profiles/phone/package.json","dsh-home/profiles/phone/.dsh-purge-runtime/current.json","dsh-home/profiles/phone/.dsh-purge-runtime/history/keep").associateWith { File(root,it).readText() }
    @Before fun seed() {
        root=File(RuntimeEnvironment.getApplication().cacheDir,"peer-upgrade-${java.util.UUID.randomUUID()}").canonicalFile.apply{mkdirs()}
        put("dsh.version","121")
        put("tree/node_modules/@deepseek-ai/dsh/package.json","{\"version\":\"0.2.1-alpha.1\"}")
        bases.forEach { base -> names.take(5).forEach { put("$base/$it",old(it)!!) } }
        put("dsh-home/extensions/中文 空格工具/main.mjs","unique custom extension")
        put("dsh-home/skills/user/SKILL.md","user skill")
        put("dsh-home/storage/session.jsonl","existing session")
        put("dsh-home/credentials.json","synthetic existing credentials")
        put("dsh-home/profiles/phone/package.json","{\"user\":true}")
        put("dsh-home/profiles/phone/.dsh-purge-runtime/current.json","{\"privateSDK\":\"keep\"}")
        put("dsh-home/profiles/phone/.dsh-purge-runtime/history/keep","history intact")
    }
    private fun install(beforeCommit:()->Unit = {})=PhonePeerUpgrade.install(root,manifest(),next(),beforeCommit)
    private fun assertOld() { bases.forEach { base -> names.forEach { name ->
        val f=File(root,"$base/$name"); val bytes=old(name)
        if(bytes==null) assertFalse(f.exists()) else assertArrayEquals(bytes,f.readBytes())
    } };assertEquals("121",File(root,"dsh.version").readText()) }
    private fun assertNew() { bases.forEach { base -> next().forEach { (name,bytes) -> assertArrayEquals(bytes,File(root,"$base/$name").readBytes()) } };assertEquals("122",File(root,"dsh.version").readText()) }
    private fun context()=object:ContextWrapper(RuntimeEnvironment.getApplication()) { override fun getFilesDir()=root }
    @Test fun actualSignedAssetsChain119120And121WithoutReplacingPrivateDescriptor() {
        for(version in listOf("119","120","121")) {
            seed();put("dsh.version",version)
            val runner="node_modules/@deepseek-ai/dsh-compaction-basic/lib/summary-runner.mjs"
            val bytes=if(version=="121") context().assets.open("compaction-summary-runner.mjs").use{it.readBytes()} else old("summary-runner.mjs")!!
            put("tree/$runner",bytes);put("dsh-home/profiles/phone/$runner",bytes)
            val token="11111111-2222-3333-4444-555555555555"
            val profile=File(root,"dsh-home/profiles/phone").canonicalFile
            val run=File(profile,".dsh-purge-runtime/$token")
            val lib=File(run,"node_modules/@deepseek-ai/dsh-compaction-basic/lib")
            if(version=="121") put(lib.relativeTo(root).path+"/summary-runner.mjs",bytes)
            else put(lib.relativeTo(root).path+"/index.js",old("legacy-index.js")!!)
            put("dsh-home/profiles/phone/.dsh-purge-runtime/current.json",JSONObject().put("owner","dsh-purge-community-private-runtime-v1")
                .put("phase","installed").put("token",token).put("profileDir",profile.path).put("runDir",run.path)
                .put("aiBase",File(run,"node_modules/@deepseek-ai").path).toString())
            val before=protected()
            assertTrue(PhonePeerUpgrade.applyIfSupported(context(),"122"))
            assertEquals("122",File(root,"dsh.version").readText());assertEquals(before,protected())
            assertTrue(PhoneCompactionUpgrade.targets(root).all{PhoneCompactionUpgrade.digest(it.readBytes())==PhoneCompactionUpgrade.FIXED})
            assertTrue(PhonePeerUpgrade.applyIfSupported(context(),"122"));assertEquals(before,protected())
        }
    }
    @Test fun peerPreflightFailureDoesNotRunLegacyMutationOrAllowUnknownVersionFallback() {
        put("dsh.version","120");put("${bases.last()}/index.mjs","unknown peer patch")
        assertTrue(runCatching{PhonePeerUpgrade.applyIfSupported(context(),"122")}.isFailure)
        assertEquals("120",File(root,"dsh.version").readText())
        put("dsh.version","117");assertTrue(runCatching{PhonePeerUpgrade.applyIfSupported(context(),"122")}.isFailure)
        assertEquals("117",File(root,"dsh.version").readText())
        File(root,"dsh.version").delete();assertTrue(runCatching{PhonePeerUpgrade.applyIfSupported(context(),"122")}.isFailure)
        val empty=File(root,"fresh").apply{mkdirs()}
        val fresh=object:ContextWrapper(context()) { override fun getFilesDir()=empty }
        assertFalse(PhonePeerUpgrade.applyIfSupported(fresh,"122"))
    }
    @Test fun upgradesOnlyPeerProgramsAndIsIdempotent() {
        val before=protected();install();assertNew();assertEquals(before,protected())
        install();assertNew();assertEquals(before,protected())
        assertEquals(1,File(root,"remote-peer-upgrades").listFiles()!!.size)
    }
    @Test fun preflightsAllCopiesAndUnknownPatchPreservesEverything() {
        put("${bases.last()}/protocol.mjs","unknown user patch")
        val before=protected()
        assertTrue(runCatching { install() }.isFailure)
        assertArrayEquals(old("index.mjs"),File(root,"${bases.first()}/index.mjs").readBytes())
        assertEquals("unknown user patch",File(root,"${bases.last()}/protocol.mjs").readText())
        assertEquals("121",File(root,"dsh.version").readText());assertEquals(before,protected())
    }
    @Test fun symbolicLinkInTargetOrAncestorAndUnknownSdkAreRejected() {
        val p=File(root,"${bases.last()}/index.mjs");p.delete()
        val outside=put("outside.mjs","external unchanged")
        Files.createSymbolicLink(p.toPath(),outside.toPath())
        assertTrue(runCatching { install() }.isFailure);assertEquals("external unchanged",outside.readText())
        Files.delete(p.toPath());p.writeBytes(old("index.mjs")!!)
        val base=File(root,bases.last());val moved=File(root,"peer-real");check(base.renameTo(moved));Files.createSymbolicLink(base.toPath(),moved.toPath())
        assertTrue(runCatching { install() }.isFailure);Files.delete(base.toPath());check(moved.renameTo(base))
        put("tree/node_modules/@deepseek-ai/dsh/package.json","{\"version\":\"unknown\"}")
        assertTrue(runCatching { install() }.isFailure);assertOld()
    }
    @Test fun signedManifestHasExactWhitelistOldHashesAndPayloadLengths() {
        listOf(manifest().replace("index.mjs","../index.mjs"),manifest().replace("\"targetVersion\":\"122\"","\"targetVersion\":\"123\""),
            manifest().replace(PhoneCompactionUpgrade.digest(old("index.mjs")!!),"0".repeat(64))).forEach { bad ->
            assertTrue(runCatching { PhonePeerUpgrade.install(root,bad,next()) }.isFailure);assertOld()
        }
        assertTrue(runCatching { PhonePeerUpgrade.install(root,manifest(),next()+ ("index.mjs" to "wrong".toByteArray())) }.isFailure);assertOld()
        assertTrue(runCatching { PhonePeerUpgrade.install(root,manifest(next().filterKeys { it!="relay.mjs" }),next()) }.isFailure);assertOld()
    }
    @Test fun precommitFailureRestoresProgramsAndRemovesOnlyOwnedAdditions() {
        val before=protected();assertTrue(runCatching { install { error("injected failure") } }.isFailure)
        assertOld();assertEquals(before,protected());assertFalse(File(root,"remote-peer-upgrade-pending.json").exists())
        install();assertNew()
    }
    @Test fun concurrentEditBlocksAllRollbackUntilExplicitlyReconciled() {
        val changed=File(root,"${bases.last()}/index.mjs")
        assertTrue(runCatching { install { changed.writeText("concurrent edit");error("failure") } }.isFailure)
        assertEquals("concurrent edit",changed.readText());assertTrue(File(root,"remote-peer-upgrade-pending.json").isFile)
        assertArrayEquals(next().getValue("index.mjs"),File(root,"${bases.first()}/index.mjs").readBytes())
        assertTrue(runCatching { PhonePeerUpgrade.recover(root) }.isFailure);assertEquals("concurrent edit",changed.readText())
        changed.writeBytes(next().getValue("index.mjs"));PhonePeerUpgrade.recover(root);assertOld()
    }
    @Test fun interruptedTransactionAndMarkerWindowRecoverBeforeVersionEarlyReturn() {
        install()
        val completed=File(root,"remote-peer-upgrades").listFiles()!!.single().resolve("completed.json")
        val j=JSONObject(completed.readText()).put("committed",false)
        File(root,"remote-peer-upgrade-pending.json").writeText(j.toString())
        PhonePeerUpgrade.recover(root);assertOld()
    }
    @Test fun committedJournalCannotHideConcurrentRevertOrMarkerEdit() {
        install()
        val completed=File(root,"remote-peer-upgrades").listFiles()!!.single().resolve("completed.json")
        File(root,"remote-peer-upgrade-pending.json").writeText(completed.readText())
        put("${bases.first()}/index.mjs",old("index.mjs")!!)
        assertTrue(runCatching { PhonePeerUpgrade.recover(root) }.isFailure)
        assertTrue(File(root,"remote-peer-upgrade-pending.json").exists())
    }
    @Test fun guardedCommittedRollbackPreservesDataAndRefusesConcurrentProgram() {
        val before=protected();install();val id=File(root,"remote-peer-upgrades").listFiles()!!.single().name
        val f=File(root,"${bases.first()}/remote-service.mjs");f.writeText("new concurrent program")
        assertTrue(runCatching { PhonePeerUpgrade.rollbackCommitted(root,id) }.isFailure)
        assertEquals("122",File(root,"dsh.version").readText());assertEquals("new concurrent program",f.readText())
        f.writeBytes(next().getValue("remote-service.mjs"));PhonePeerUpgrade.rollbackCommitted(root,id)
        assertOld();assertEquals(before,protected())
    }
}
