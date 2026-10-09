package com.dshphone

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermission
import java.security.MessageDigest
import java.util.UUID

class RecoveryInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    private fun report(name: String) = sendStatus(0, Bundle().apply { putString("stream", "PASS: $name\n") })
    private fun hash(file: File): String = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
    override fun onStart() {
        try {
            val ctx = targetContext
            check(ctx.packageName.startsWith("com.dshphone.recoveryverification."))
            val base = ctx.filesDir
            fun put(path: String, text: String): File = File(base, path).apply { parentFile!!.mkdirs(); writeText(text) }
            val bin = put("tree/node_modules/@deepseek-ai/dsh/lib/bin.js", "good engine")
            put("tree/node_modules/@deepseek-ai/dsh/package.json", """{"version":"0.2.1-alpha.1"}""")
            val manifest = put("dsh-home/profiles/phone/package.json", "good profile")
            val plugin = put("dsh-home/profiles/phone/node_modules/fixture/index.js", "good plugin")
            val executable = put("tree/tool", "executable")
            executable.setExecutable(true, true)
            Files.createSymbolicLink(File(base, "dsh-home/node_modules").toPath(), File(base, "tree/node_modules").toPath())
            put("dsh.version", "old-assets")
            put("dsh-home/settings.yaml", "old settings")
            val credential = put("dsh-home/.credentials.yaml", "fixture account and persona card")
            val conversation = put("dsh-home/sessions/latest/message.json", "latest response")
            val workspace = put("dsh-home/workspace/working.txt", "user work")
            check(RecoveryManager.status(ctx).length() == 0)
            val first = RecoveryManager.backup(ctx)
            val records = JSONObject(File(base, "recovery/${first.getString("id")}/manifest.json").readText()).getJSONArray("entries")
            check((0 until records.length()).none { records.getJSONObject(it).getString("path").contains(".credentials") || records.getJSONObject(it).getString("path").contains("sessions/") })
            report("snapshot contains environment only and never credentials or conversation files")

            credential.writeText("new login and new persona"); conversation.writeText("new response after backup"); workspace.writeText("latest user work")
            plugin.writeText("broken plugin"); manifest.writeText("broken profile"); bin.writeText("broken engine")
            put("dsh-home/profiles/phone/node_modules/new-bad-plugin/index.js", "new bad plugin")
            put("dsh-home/settings.yaml", "broken settings")
            RecoveryManager.restore(ctx, "latest")
            check(plugin.readText() == "good plugin" && manifest.readText() == "good profile" && bin.readText() == "good engine")
            check(!File(base, "dsh-home/profiles/phone/node_modules/new-bad-plugin").exists())
            check(File(base, "dsh-home/settings.yaml").readText() == "old settings")
            check(credential.readText() == "new login and new persona" && conversation.readText() == "new response after backup" && workspace.readText() == "latest user work")
            check(Files.isSymbolicLink(File(base, "dsh-home/node_modules").toPath()))
            check(executable.canExecute() && File(base, "dsh.version").readText() == NodeRunner.ASSET_VERSION)
            report("broken plugin rollback preserves newest accounts, personas, conversations, workspace, links and executable permissions")

            RecoveryManager.restore(ctx, "undo")
            check(plugin.readText() == "broken plugin" && manifest.readText() == "broken profile")
            RecoveryManager.restore(ctx, "undo")
            check(plugin.readText() == "good plugin")
            report("undo saves current environment and can undo the previous rollback")

            bin.writeText("second good engine"); val second = RecoveryManager.backup(ctx)
            check(RecoveryManager.status(ctx).getJSONObject("previous").getString("id") == first.getString("id"))
            val archive = File(base, "recovery/${second.getString("id")}/payload.zip"); archive.appendText("corrupt")
            val before = hash(bin)
            check(runCatching { RecoveryManager.restore(ctx, "latest") }.isFailure && hash(bin) == before)
            RecoveryManager.restore(ctx, "previous")
            check(bin.readText() == "good engine" && credential.readText() == "new login and new persona")
            report("two snapshot rotation and corrupted archive rejection leave current environment intact")

            // An interrupted swap must roll back before the next engine start.
            fun interrupted(committed: Boolean) {
                val incoming = File(base, "recovery/incoming-${UUID.randomUUID()}").apply { mkdirs() }
                val holding = File(base, "recovery/holding-${UUID.randomUUID()}").apply { mkdirs() }
                val scopes = listOf("tree", "dsh-home/profiles", "dsh-home/node_modules", "dsh-home/settings.yaml", "dsh.version")
                val flags = JSONObject(); scopes.forEach { flags.put(it, Files.exists(File(base, it).toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) }
                check(File(base, "tree").renameTo(File(holding, "tree")))
                put("tree/node_modules/@deepseek-ai/dsh/lib/bin.js", "half applied engine")
                File(base, "recovery/restore-journal.json").writeText(JSONObject().put("incoming", incoming.name).put("holding", holding.name).put("existed", flags).put("committed", committed).toString())
                RecoveryManager.recoverInterruptedRestore(ctx)
                check(bin.readText() == if (committed) "half applied engine" else "good engine")
                check(!incoming.exists() && !holding.exists() && !File(base, "recovery/restore-journal.json").exists())
            }
            interrupted(false)
            report("interrupted multi-directory restore rolls back original engine before startup")
            interrupted(true)
            report("committed restore survives cleanup interruption")
            // Repair fixture and create an invalid link without allowing any live writes.
            put("tree/node_modules/@deepseek-ai/dsh/package.json", """{"version":"0.2.1-alpha.1"}""")
            val safe = RecoveryManager.backup(ctx)
            val snapshotDir = File(base, "recovery/${safe.getString("id")}")
            val metadataFile = File(snapshotDir, "info.json"); val metadata = JSONObject(metadataFile.readText())
            val recordFile = File(snapshotDir, "manifest.json"); val content = JSONObject(recordFile.readText()); val list = content.getJSONArray("entries")
            list.put(JSONObject().put("path", "dsh-home/profiles/phone/escape").put("type", "link").put("target", "/sdcard/unsafe").put("mode", 511))
            recordFile.writeText(content.toString()); metadata.put("manifestSha256", hash(recordFile)); metadataFile.writeText(metadata.toString())
            val liveHash = hash(bin)
            check(runCatching { RecoveryManager.restore(ctx, "latest") }.isFailure && hash(bin) == liveHash)
            report("out of scope symlink rejected before changing live files")
            list.remove(list.length() - 1)
            list.put(JSONObject().put("path", "../outside").put("type", "directory").put("mode", 448))
            recordFile.writeText(content.toString()); metadata.put("manifestSha256", hash(recordFile)); metadataFile.writeText(metadata.toString())
            check(runCatching { RecoveryManager.restore(ctx, "latest") }.isFailure && hash(bin) == liveHash)
            report("archive path traversal rejected before changing live files")
            // Native disabling works without a Web server and never removes the built-in host bundles.
            put("dsh-home/profiles/phone/package.json", """{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","dsh-phone-qq","fixture"]}}}""")
            check(RecoveryManager.communityPlugins(ctx) == listOf("fixture"))
            check(runCatching { RecoveryManager.disablePlugins(ctx, listOf("dsh-phone-qq")) }.isFailure)
            RecoveryManager.disablePlugins(ctx, listOf("fixture"))
            check(RecoveryManager.communityPlugins(ctx).isEmpty())
            check(credential.readText() == "new login and new persona" && conversation.readText() == "new response after backup")
            RecoveryManager.restore(ctx, "latest")
            check(RecoveryManager.communityPlugins(ctx) == listOf("fixture"))
            report("native community-plugin disabling protects built-ins, backs up first and can be restored without losing user data")
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "DSH_RECOVERY_TESTS_OK\n") })
        } catch (error: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("stream", "DSH_RECOVERY_TESTS_FAILED: ${error.javaClass.simpleName}: ${error.message}\n") })
        }
    }
}
