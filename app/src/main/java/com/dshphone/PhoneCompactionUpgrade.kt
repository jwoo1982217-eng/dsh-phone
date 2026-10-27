package com.dshphone

import android.content.Context
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** Guarded 119/120→121 update, including original and split private SDK layouts. */
internal object PhoneCompactionUpgrade {
    internal const val OLD = "524b97de30f99d816fbf81da6936ac3c2bf1a0bc27d88c8dce83d349aab924e7"
    internal const val FIXED = "17da3fb22dcd7b209424b2a64894023cf54cdff4e0a37e1aae4f05c1bda99404"
    private const val RUNNER = "node_modules/@deepseek-ai/dsh-compaction-basic/lib/summary-runner.mjs"
    private const val OWNER = "dsh-purge-community-private-runtime-v1"
    private fun journal(root: File) = File(root, "compaction-upgrade-pending.json")
    internal fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun publish(file: File, bytes: ByteArray) {
        val next = File(file.parentFile, ".${file.name}.${UUID.randomUUID()}.next")
        try {
            next.outputStream().use { it.write(bytes); it.fd.sync() }
            Files.move(next.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { next.delete() }
    }
    private fun publish(file: File, text: String) = publish(file, text.toByteArray())
    internal fun physical(root: File, file: File, required: Boolean = true): File {
        val base = root.canonicalFile
        val normalized = file.absoluteFile.toPath().normalize().toFile()
        check(normalized.toPath().startsWith(base.toPath()) && normalized != base) { "升级路径越界" }
        var cursor: File? = normalized
        while (cursor != base) {
            check(cursor != null && !Files.isSymbolicLink(cursor.toPath())) { "升级路径包含独立链接，原文件保持" }
            cursor = cursor.parentFile
        }
        if (required) check(normalized.isFile) { "压缩程序缺失，原文件保持" }
        return normalized
    }
    private fun privateRun(root: File): File? {
        val profile = File(root, "dsh-home/profiles/phone")
        val current = File(profile, ".dsh-purge-runtime/current.json")
        if (!current.exists()) return null
        physical(root, current)
        val state = JSONObject(current.readText())
        check(state.getString("owner") == OWNER) { "未知私有SDK所有者" }
        if (state.getString("phase") != "installed") return null
        val token = state.getString("token")
        check(token.matches(Regex("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")))
        check(File(state.getString("profileDir")).canonicalFile == profile.canonicalFile)
        val run = File(profile, ".dsh-purge-runtime/$token")
        check(File(state.getString("runDir")).canonicalFile == run.canonicalFile)
        check(File(state.getString("aiBase")).canonicalFile == File(run, "node_modules/@deepseek-ai").canonicalFile)
        return run
    }
    internal fun targets(files: File): List<File> {
        val root = files.canonicalFile
        val result = mutableListOf(physical(root, File(root, "tree/$RUNNER")))
        val profile = File(root, "dsh-home/profiles/phone")
        val profileRunner = File(profile, RUNNER)
        if (Files.exists(profileRunner.toPath(), LinkOption.NOFOLLOW_LINKS)) result.add(physical(root, profileRunner))
        privateRun(root)?.let { run ->
            val runner = physical(root, File(run, RUNNER), required = false)
            if (Files.exists(runner.toPath(), LinkOption.NOFOLLOW_LINKS)) result.add(physical(root, runner))
            else LegacyCompactionFiles.verify(root, runner.parentFile!!)
        }
        return result.distinctBy { it.path }
    }
    @Synchronized fun recover(files: File) {
        val root = files.canonicalFile
        val record = journal(root)
        if (!record.exists()) return
        physical(root, record)
        val j = JSONObject(record.readText())
        val id = j.getString("id")
        val format = j.getInt("format")
        check(format in 1..2 && id.matches(Regex("[0-9a-f-]{36}")))
        val backup = File(root, "compaction-upgrades/$id")
        if (!j.getBoolean("committed")) {
            val fromVersion = if (format == 1) "119" else j.getString("fromVersion")
            check(fromVersion in setOf("119", "120"))
            check(File(root, "dsh.version").readText().trim() in setOf("119", "120", "121"))
            val rows = j.getJSONArray("files")
            val allowed = mutableMapOf("tree/$RUNNER" to FIXED, "dsh-home/profiles/phone/$RUNNER" to FIXED)
            privateRun(root)?.let { run ->
                val lib = File(run, RUNNER).parentFile!!
                allowed[File(lib, "index.js").relativeTo(root).path] = LegacyCompactionFiles.ADAPTED
                LegacyCompactionFiles.helperHashes.forEach { (name, hash) -> allowed[File(lib, name).relativeTo(root).path] = hash }
            }
            val restores = (0 until rows.length()).map { i ->
                val row = rows.getJSONObject(i)
                val relative = row.getString("path")
                val after = if (format == 1) FIXED else row.getString("after")
                check(allowed[relative] == after)
                val oldHash = if (row.isNull("old")) null else row.getString("old")
                check(oldHash == null || oldHash == OLD || oldHash == LegacyCompactionFiles.INDEX)
                val target = physical(root, File(root, relative), required = oldHash != null)
                if (target.exists()) check(digest(target.readBytes()) in setOfNotNull(oldHash, after)) { "压缩程序已有并发修改，停止自动回退" }
                val old = oldHash?.let {
                    physical(root, File(backup, "$i.mjs")).readBytes().also { bytes -> check(digest(bytes) == it) }
                }
                target to old
            }
            restores.forEach { (target, bytes) -> if (bytes != null) publish(target, bytes) else if (target.exists()) check(target.delete()) }
            publish(File(root, "dsh.version"), fromVersion)
        }
        check(record.renameTo(File(backup, if (j.getBoolean("committed")) "completed.json" else "restored.json")))
    }
    @Synchronized internal fun install(files: File, fixed: ByteArray, helpers: Map<String, ByteArray> = emptyMap(), beforeCommit: () -> Unit = {}) {
        val root = files.canonicalFile
        recover(root)
        check(digest(fixed) == FIXED)
        val fromVersion = File(root, "dsh.version").readText().trim()
        check(fromVersion in setOf("119", "120"))
        val core = physical(root, File(root, "tree/node_modules/@deepseek-ai/dsh/package.json"))
        check(JSONObject(core.readText()).getString("version") == "0.2.1-alpha.1") { "本次压缩更新要求已验证的alpha.1核心" }
        val all = targets(root)
        // Validate every copy before changing any file; preserve unknown user patches.
        val bytes = all.associateWith { it.readBytes() }
        check(bytes.values.all { digest(it) in setOf(OLD, FIXED) }) { "压缩程序有未识别改动，升级停止；原文件保持" }
        val changed = all.filter { digest(bytes.getValue(it)) == OLD }.map {
            CompactionFileChange(it, bytes.getValue(it), fixed)
        }.toMutableList()
        privateRun(root)?.let { run ->
            val runner = physical(root, File(run, RUNNER), required = false)
            if (!runner.exists()) changed.addAll(LegacyCompactionFiles.plan(root, runner.parentFile!!, helpers + ("summary-runner.mjs" to fixed)))
        }
        val id = UUID.randomUUID().toString()
        val backup = File(root, "compaction-upgrades/$id")
        check(backup.mkdirs())
        val rows = JSONArray()
        changed.forEachIndexed { i, change ->
            change.before?.let { old -> File(backup, "$i.mjs").outputStream().use { it.write(old); it.fd.sync() } }
            rows.put(JSONObject().put("path", change.file.relativeTo(root).path)
                .put("old", change.before?.let(::digest) ?: JSONObject.NULL).put("after", digest(change.after)))
        }
        val j = JSONObject().put("format", 2).put("id", id).put("fromVersion", fromVersion).put("files", rows).put("committed", false)
        publish(journal(root), j.toString())
        try {
            changed.forEach { change ->
                physical(root, change.file, required = change.before != null)
                check(if (change.before == null) !change.file.exists() else change.file.readBytes().contentEquals(change.before)) { "压缩程序升级前发生并发修改" }
                publish(change.file, change.after)
            }
            beforeCommit()
            check(all.all { digest(it.readBytes()) == FIXED })
            check(changed.all { it.file.readBytes().contentEquals(it.after) })
            publish(File(root, "dsh.version"), "121")
            j.put("committed", true)
            publish(journal(root), j.toString())
            recover(root)
        } catch (error: Throwable) {
            try { recover(root) } catch (recovery: Throwable) { error.addSuppressed(recovery) }
            throw error
        }
    }
    fun applyIfSupported(ctx: Context, targetVersion: String): Boolean {
        val version = File(ctx.filesDir, "dsh.version")
        if (targetVersion != "121" || !version.isFile || version.readText().trim() !in setOf("119", "120")) return false
        val helpers = listOf("summary-budget.mjs", "summary-checkpoint.mjs").associateWith { name ->
            ctx.assets.open("compaction-$name").use { it.readBytes() }
        }
        install(ctx.filesDir, ctx.assets.open("compaction-summary-runner.mjs").use { it.readBytes() }, helpers)
        PhoneJetHubAlias.prepare(ctx.filesDir)
        return true
    }
}
