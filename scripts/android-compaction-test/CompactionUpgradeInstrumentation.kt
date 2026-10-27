package com.dshphone

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import java.io.File
import java.nio.file.Files
import org.json.JSONObject

/** Disposable UID only. The real NodeRunner and production migrator execute. */
class CompactionUpgradeInstrumentation : Instrumentation() {
    private var phase = ""
    private val token = "11111111-2222-3333-4444-555555555555"
    private val runner = "node_modules/@deepseek-ai/dsh-compaction-basic/lib/summary-runner.mjs"
    private fun old() = targetContext.assets.open("fixture-old-runner.mjs").use { it.readBytes() }
    private fun fixed() = targetContext.assets.open("compaction-summary-runner.mjs").use { it.readBytes() }
    private fun legacy() = targetContext.assets.open("fixture-legacy-index.js").use { it.readBytes() }
    private fun helpers() = listOf("summary-budget.mjs", "summary-checkpoint.mjs").associateWith { name ->
        targetContext.assets.open("compaction-$name").use { it.readBytes() }
    }
    private fun put(root: File, path: String, bytes: ByteArray) = File(root,path).apply { parentFile!!.mkdirs();writeBytes(bytes) }
    private fun put(root: File, path: String, text: String) = put(root,path,text.toByteArray())
    private fun privateRunner(root: File) = File(root,"dsh-home/profiles/phone/.dsh-purge-runtime/$token/$runner")
    private fun protected(root: File) = listOf(
        "dsh-home/profiles/phone/package.json", "dsh-home/profiles/phone/.dsh-purge-runtime/current.json",
        "dsh-home/extensions/中文 自定义工具/index.mjs", "dsh-home/skills/user/SKILL.md",
        "dsh-home/settings.yaml", "dsh-home/storage/session.jsonl",
        "dsh-home/profiles/phone/.dsh-purge-runtime/history/$runner"
    ).associateWith { PhoneCompactionUpgrade.digest(File(root,it).readBytes()) }
    private fun seed(root: File, legacyLayout: Boolean = false) {
        root.mkdirs()
        put(root,"dsh.version","119")
        put(root,"tree/node_modules/@deepseek-ai/dsh/package.json","{\"version\":\"0.2.1-alpha.1\"}")
        put(root,"tree/node_modules/@deepseek-ai/dsh/lib/bin.js","// fixture; never start a core")
        put(root,"tree/$runner",old())
        put(root,"dsh-home/profiles/phone/$runner",old())
        val profile = File(root,"dsh-home/profiles/phone").canonicalFile
        val run = File(profile,".dsh-purge-runtime/$token")
        privateRunner(root).apply { parentFile!!.mkdirs();writeBytes(old()) }
        if (legacyLayout) {
            check(privateRunner(root).delete())
            File(privateRunner(root).parentFile, "index.js").writeBytes(legacy())
        }
        put(root,"dsh-home/profiles/phone/package.json", """{"dsh":{"profile":{"bundles":["dsh-purge-private-$token-bundle-0","custom-tool"]}},"dependencies":{"custom-tool":"file:../../extensions/中文 自定义工具"}}""")
        put(root,"dsh-home/profiles/phone/.dsh-purge-runtime/current.json", JSONObject()
            .put("owner","dsh-purge-community-private-runtime-v1").put("phase","installed")
            .put("token",token).put("profileDir",profile.path).put("runDir",run.path)
            .put("aiBase",File(run,"node_modules/@deepseek-ai").path).toString())
        put(root,"dsh-home/profiles/phone/.dsh-purge-runtime/history/$runner",old())
        put(root,"dsh-home/extensions/中文 自定义工具/index.mjs","export const tool = 'keep';")
        put(root,"dsh-home/skills/user/SKILL.md","用户技能保持")
        put(root,"dsh-home/settings.yaml","user: keep\nexternalMcp: https://example.invalid/mcp\n")
        put(root,"dsh-home/storage/session.jsonl","{\"fixture\":\"existing session\"}\n")
    }
    private fun checkOld(root: File) {
        check(PhoneCompactionUpgrade.targets(root).all { PhoneCompactionUpgrade.digest(it.readBytes()) == PhoneCompactionUpgrade.OLD })
        check(File(root,"dsh.version").readText() == "119")
    }
    private fun cases() {
        val root = File(targetContext.filesDir,"boundary-fixture")
        seed(root)
        val before = protected(root)
        privateRunner(root).writeText("unknown user patch")
        check(runCatching { PhoneCompactionUpgrade.install(root,fixed()) }.isFailure)
        check(File(root,"tree/$runner").readBytes().contentEquals(old()))
        check(privateRunner(root).readText() == "unknown user patch")
        check(File(root,"dsh.version").readText() == "119")
        privateRunner(root).writeBytes(old())
        val external = put(root,"preserve-outside.mjs","keep external")
        check(privateRunner(root).delete())
        Files.createSymbolicLink(privateRunner(root).toPath(),external.toPath())
        check(runCatching { PhoneCompactionUpgrade.install(root,fixed()) }.isFailure)
        check(external.readText() == "keep external")
        Files.delete(privateRunner(root).toPath()); privateRunner(root).writeBytes(old())
        check(runCatching { PhoneCompactionUpgrade.install(root,fixed()) { error("injected precommit failure") } }.isFailure)
        checkOld(root); check(protected(root) == before)
        check(!File(root,"compaction-upgrade-pending.json").exists())
        // A concurrent edit must prevent automatic rollback from overwriting it.
        check(runCatching { PhoneCompactionUpgrade.install(root,fixed()) {
            privateRunner(root).writeText("concurrent private edit"); error("injected concurrent failure")
        } }.isFailure)
        check(privateRunner(root).readText() == "concurrent private edit")
        check(File(root,"compaction-upgrade-pending.json").isFile)
        privateRunner(root).writeBytes(fixed())
        PhoneCompactionUpgrade.recover(root); checkOld(root)
        check(protected(root) == before)
        // Missing profile SDK copy is normal for the installed private overlay layout.
        check(File(root,"dsh-home/profiles/phone/$runner").delete())
        check(PhoneCompactionUpgrade.targets(root).size == 2)
        PhoneCompactionUpgrade.install(root,fixed())
        check(File(root,"dsh.version").readText() == "121")
        check(protected(root) == before)
        check(root.deleteRecursively())
    }
    private fun legacyCases() {
        val root = File(targetContext.filesDir, "legacy-boundary-fixture")
        seed(root, legacyLayout = true)
        val before = protected(root)
        val lib = privateRunner(root).parentFile!!
        val index = File(lib, "index.js")
        fun restored() {
            checkOld(root)
            check(index.readBytes().contentEquals(legacy()))
            check(LegacyCompactionFiles.helperHashes.keys.none { File(lib, it).exists() })
            check(protected(root) == before)
        }
        check(runCatching { PhoneCompactionUpgrade.install(root, fixed()) }.isFailure)
        restored()
        index.writeText("independent user edit")
        check(runCatching { PhoneCompactionUpgrade.install(root, fixed(), helpers()) }.isFailure)
        check(index.readText() == "independent user edit")
        index.writeBytes(legacy())
        check(runCatching { PhoneCompactionUpgrade.install(root, fixed(), helpers()) { error("legacy rollback") } }.isFailure)
        restored()
        check(runCatching { PhoneCompactionUpgrade.install(root, fixed(), helpers()) {
            privateRunner(root).writeText("concurrent addition"); error("legacy concurrent edit")
        } }.isFailure)
        check(privateRunner(root).readText() == "concurrent addition")
        privateRunner(root).writeBytes(fixed())
        PhoneCompactionUpgrade.recover(root)
        restored()
        PhoneCompactionUpgrade.install(root, fixed(), helpers())
        check(File(root, "dsh.version").readText() == "121")
        check(PhoneCompactionUpgrade.digest(index.readBytes()) == LegacyCompactionFiles.ADAPTED)
        check(LegacyCompactionFiles.helperHashes.all { (name, hash) -> PhoneCompactionUpgrade.digest(File(lib, name).readBytes()) == hash })
        check(protected(root) == before)
        check(root.deleteRecursively())
    }
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments);phase=arguments?.getString("phase") ?: "";start() }
    override fun onStart() {
        try {
            check(targetContext.packageName.matches(Regex("com\\.dshphone\\.compactionverification\\.t[a-f0-9]{32}")))
            val root = targetContext.filesDir
            if (phase == "before") {
                seed(root, legacyLayout = true);checkOld(root)
                put(root,"protected-before.json",JSONObject(protected(root)).toString())
            } else {
                check(phase == "after")
                checkOld(root)
                cases()
                legacyCases()
                NodeRunner.ensureExtracted(targetContext)
                check(File(root,"dsh.version").readText() == "121")
                check(PhoneCompactionUpgrade.targets(root).size == 3)
                check(PhoneCompactionUpgrade.targets(root).all { PhoneCompactionUpgrade.digest(it.readBytes()) == PhoneCompactionUpgrade.FIXED })
                val before = JSONObject(File(root,"protected-before.json").readText())
                check(protected(root).all { (name,hash) -> before.getString(name) == hash })
                val count = File(root,"compaction-upgrades").list()!!.size
                NodeRunner.ensureExtracted(targetContext)
                check(File(root,"compaction-upgrades").list()!!.size == count)
                check(!File(root,"compaction-upgrade-pending.json").exists())
            }
            finish(Activity.RESULT_OK,Bundle().apply { putString("stream","DSH_COMPACTION_${phase.uppercase()}_OK privateSDK=true preservation=true failureRecovery=true\n") })
        } catch (error: Throwable) {
            finish(Activity.RESULT_CANCELED,Bundle().apply { putString("stream",error.stackTraceToString()) })
        }
    }
}
