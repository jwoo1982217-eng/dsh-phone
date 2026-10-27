package com.dshphone

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.util.UUID

/** Signed-APK program-only migration. No SDK, profile configuration or user data extraction. */
internal object PhonePeerUpgrade {
    private val old = linkedMapOf(
        "index.mjs" to "9ccb639041f65f08228366c1714529f444c56aaefc0a3b643ef4ebb870467d57",
        "tunnel.mjs" to "93441c3e2347816ef5397e3227d58290611e8c6b3d36427ed72663d669a7da1b",
        "relay.mjs" to "6127d0812f4fdc5989a32e2036f92a309918301b573de1e8c3a951e831304e21",
        "page.html" to "a32e942bc842aaf995c03f98d7fda57746fe8e674d0aa4b09a08f800b8d869c0",
        "protocol.mjs" to "38882b147defb7d3e32301a2076d3fb97e2d08176e1d09d4487153b96533430e",
        "remote-service.mjs" to null, "transport-proxy.mjs" to null,
    )
    private val bases = listOf("tree/node_modules/dsh-peer", "dsh-home/profiles/phone/node_modules/dsh-peer")
    private fun pending(root: File) = File(root, "remote-peer-upgrade-pending.json")
    private fun hash(bytes: ByteArray) = PhoneCompactionUpgrade.digest(bytes)
    private fun file(root: File, path: String, required: Boolean = true) = PhoneCompactionUpgrade.physical(root, File(root, path), required)
    private fun exists(file: File) = Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS)
    private fun syncDirectory(dir: File) { FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) } }
    private fun publish(file: File, bytes: ByteArray) {
        val temporary = File(file.parentFile, ".${file.name}.${UUID.randomUUID()}.next")
        try {
            temporary.outputStream().use { it.write(bytes); it.fd.sync() }
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            syncDirectory(file.parentFile!!)
        } finally { temporary.delete() }
    }
    private fun publish(file: File, text: String) = publish(file, text.toByteArray(Charsets.UTF_8))
    private data class Entry(val name: String, val before: String?, val after: String, val bytes: ByteArray)
    private data class Change(val file: File, val before: ByteArray?, val after: ByteArray)
    private fun entries(manifest: String, payload: Map<String, ByteArray>): List<Entry> {
        check(manifest.length <= 32 * 1024)
        val value = JSONObject(manifest)
        check(value.getInt("version") == 1 && value.getString("targetVersion") == "122" && value.getString("sdk") == "0.2.1-alpha.1")
        val rows = value.getJSONArray("files")
        check(rows.length() == old.size && payload.keys == old.keys)
        val result = (0 until rows.length()).map { i ->
            val row = rows.getJSONObject(i)
            val name = row.getString("name")
            check(old.containsKey(name)) { "未知连接程序，升级停止" }
            val before = if (row.isNull("oldSha256")) null else row.getString("oldSha256")
            check(before == old[name])
            val after = row.getString("sha256")
            val bytes = payload.getValue(name)
            check(bytes.size in 1..512 * 1024 && row.getInt("bytes") == bytes.size && hash(bytes) == after)
            Entry(name, before, after, bytes)
        }
        check(result.map { it.name }.toSet() == old.keys && result.sumOf { it.bytes.size } <= 2 * 1024 * 1024)
        return result
    }
    /** Full plan is checked before the legacy121 chain or the first peer write. */
    private fun plan(root: File, entries: List<Entry>, current: String): List<Change> {
        check(current in setOf("119", "120", "121", "122")) { "未知资源版本，保留原运行环境" }
        val sdk = file(root, "tree/node_modules/@deepseek-ai/dsh/package.json")
        check(JSONObject(sdk.readText()).getString("version") == "0.2.1-alpha.1") { "连接更新要求已验证的alpha.1核心" }
        val profileSdk = file(root, "dsh-home/profiles/phone/node_modules/@deepseek-ai/dsh/package.json", false)
        if (exists(profileSdk)) check(JSONObject(profileSdk.readText()).getString("version") == "0.2.1-alpha.1")
        return bases.filterIndexed { index, base ->
            val dir = file(root, base, false)
            if (index == 0) check(dir.isDirectory) { "本机连接程序缺失" }
            if (exists(dir)) check(dir.isDirectory)
            exists(dir)
        }.flatMap { base -> entries.map { entry ->
            val target = file(root, "$base/${entry.name}", false)
            val previous = if (exists(target)) file(root, "$base/${entry.name}").readBytes() else null
            val expected = if (current == "122") entry.after else entry.before
            check(if (expected == null) previous == null else previous != null && hash(previous) == expected) { "连接程序有未识别改动，原文件保持" }
            Change(target, previous, entry.bytes)
        } }
    }
    @Synchronized internal fun install(files: File, manifest: String, payload: Map<String, ByteArray>, beforeCommit: () -> Unit = {}) {
        val root = files.canonicalFile
        recover(root)
        val entries = entries(manifest, payload)
        val marker = file(root, "dsh.version")
        val current = marker.readText().trim()
        val changes = plan(root, entries, current)
        if (current == "122") return
        check(current == "121") { "请先完成已验证的121兼容迁移" }
        val id = UUID.randomUUID().toString()
        val backup = file(root, "remote-peer-upgrades/$id", false)
        check(backup.mkdirs())
        syncDirectory(backup.parentFile!!)
        val rows = JSONArray()
        changes.forEachIndexed { index, change ->
            change.before?.let { publish(File(backup, "$index.before"), it) }
            rows.put(JSONObject().put("path", change.file.relativeTo(root).invariantSeparatorsPath)
                .put("old", change.before?.let(::hash) ?: JSONObject.NULL).put("after", hash(change.after)))
        }
        val journal = JSONObject().put("format", 1).put("id", id).put("fromVersion", current).put("targetVersion", "122")
            .put("committed", false).put("files", rows)
        publish(pending(root), journal.toString())
        try {
            changes.forEach { change ->
                file(root, change.file.relativeTo(root).path, false)
                check(if (change.before == null) !exists(change.file) else change.file.isFile && change.file.readBytes().contentEquals(change.before)) { "连接程序升级前发生并发修改" }
                publish(change.file, change.after)
            }
            beforeCommit()
            check(changes.all { file(root, it.file.relativeTo(root).path).readBytes().contentEquals(it.after) })
            check(file(root, "dsh.version").readText().trim() == current)
            publish(marker, "122")
            journal.put("committed", true)
            publish(pending(root), journal.toString())
            recover(root)
        } catch (error: Throwable) {
            try { recover(root) } catch (recovery: Throwable) { error.addSuppressed(recovery) }
            throw error
        }
    }
    private data class Recovery(val backup: File, val changes: List<Pair<File, ByteArray?>>, val from: String)
    /** Validate the complete transaction before restoring anything, including absent additions. */
    private fun recovery(root: File, journal: JSONObject, committedRollback: Boolean = false): Recovery {
        check(journal.getInt("format") == 1 && journal.getString("targetVersion") == "122" && journal.getString("fromVersion") == "121")
        val id = journal.getString("id")
        check(id.matches(Regex("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")))
        val backup = file(root, "remote-peer-upgrades/$id", false)
        check(backup.isDirectory)
        val marker = file(root, "dsh.version").readText().trim()
        check(marker in if (committedRollback) setOf("122") else setOf("121", "122")) { "资源版本已有并发修改，停止回退" }
        val rows = journal.getJSONArray("files")
        check(rows.length() in listOf(old.size, old.size * 2))
        val seen = mutableSetOf<String>()
        val restores = (0 until rows.length()).map { index ->
            val row = rows.getJSONObject(index)
            val path = row.getString("path")
            check(seen.add(path))
            val base = bases.firstOrNull { path.startsWith("$it/") } ?: error("回退路径越界")
            val name = path.removePrefix("$base/")
            check(old.containsKey(name) && path == "$base/$name")
            val before = if (row.isNull("old")) null else row.getString("old")
            check(before == old[name])
            val after = row.getString("after")
            check(after.matches(Regex("[0-9a-f]{64}")))
            val target = file(root, path, false)
            if (exists(target)) {
                val actual = hash(file(root, path).readBytes())
                check(actual == after || !committedRollback && actual == before) { "连接程序已有并发修改，停止自动回退" }
            } else check(before == null && !committedRollback) { "连接程序已有并发删除，停止自动回退" }
            val bytes = before?.let { expected -> file(root, "remote-peer-upgrades/$id/$index.before").readBytes().also { check(hash(it) == expected) } }
            target to bytes
        }
        check(bases.filter { base -> seen.any { it.startsWith("$base/") } }.all { base -> old.keys.all { "$base/$it" in seen } })
        return Recovery(backup, restores, "121")
    }
    @Synchronized fun recover(files: File) {
        val root = files.canonicalFile
        val record = file(root, "remote-peer-upgrade-pending.json", false)
        if (!exists(record)) return
        val journal = JSONObject(file(root, record.relativeTo(root).path).readText())
        val plan = recovery(root, journal, journal.getBoolean("committed"))
        if (!journal.getBoolean("committed")) {
            plan.changes.forEach { (target, bytes) ->
                file(root, target.relativeTo(root).path, false)
                if (bytes != null) publish(target, bytes) else if (exists(target)) { check(target.delete()); syncDirectory(target.parentFile!!) }
            }
            publish(file(root, "dsh.version"), plan.from)
        }
        val receipt = File(plan.backup, if (journal.getBoolean("committed")) "completed.json" else "restored.json")
        Files.move(record.toPath(), receipt.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        syncDirectory(root); syncDirectory(plan.backup)
    }
    /** Private maintenance hook, before APK121 rollback; every owned path must still have the committed bytes. */
    @Synchronized internal fun rollbackCommitted(files: File, id: String) {
        val root = files.canonicalFile
        check(!exists(file(root, "remote-peer-upgrade-pending.json", false)))
        check(id.matches(Regex("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")))
        val receipt = file(root, "remote-peer-upgrades/$id/completed.json")
        val journal = JSONObject(receipt.readText())
        check(journal.getString("id") == id && journal.getBoolean("committed"))
        recovery(root, journal, true)
        journal.put("committed", false)
        publish(pending(root), journal.toString())
        recover(root)
    }
    fun applyIfSupported(ctx: Context, targetVersion: String): Boolean {
        if (targetVersion != "122") return false
        val root = ctx.filesDir.canonicalFile
        val marker = file(root, "dsh.version", false)
        if (!exists(marker)) {
            check(!exists(file(root, "tree", false)) && !exists(file(root, "dsh-home/profiles/phone", false))) { "资源标记缺失，保留现有程序等待检查" }
            return false
        }
        val current = file(root, "dsh.version").readText().trim()
        check(current in setOf("119", "120", "121", "122")) { "未知资源版本，保留现有运行环境" }
        val manifest = ctx.assets.open("remote-peer/manifest.json").use { String(it.readBytes(), Charsets.UTF_8) }
        val payload = old.keys.associateWith { ctx.assets.open("remote-peer/files/$it").use { stream -> stream.readBytes() } }
        plan(root, entries(manifest, payload), current)
        if (current in setOf("119", "120")) check(PhoneCompactionUpgrade.applyIfSupported(ctx, "121"))
        install(root, manifest, payload)
        return true
    }
}
