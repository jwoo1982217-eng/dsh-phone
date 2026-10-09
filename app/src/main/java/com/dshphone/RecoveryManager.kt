package com.dshphone

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Paths
import java.nio.file.attribute.PosixFilePermission
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

/** App-private environment snapshots. Conversations, credentials and workspaces are never replaced. */
object RecoveryManager {
    private val protectedBundles = setOf("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-codearts-auth", "dsh-phone-account", "dsh-phone-qq", "dsh-phone-control", "dsh-phone-cloud-tools", "dsh-peer", "@zseven-w/dsh-noema")
    private val scopes = listOf("tree", "dsh-home/profiles", "dsh-home/node_modules", "dsh-home/settings.yaml", "dsh.version")
    private const val MAX_FILES = 120_000
    private const val MAX_BYTES = 4L * 1024 * 1024 * 1024
    private const val RESERVE = 64L * 1024 * 1024
    private fun root(ctx: Context) = File(ctx.filesDir, "recovery").apply { mkdirs() }
    private fun index(ctx: Context): JSONObject = File(root(ctx), "index.json").let {
        if (it.exists()) JSONObject(it.readText()) else JSONObject()
    }
    private fun exists(file: File) = Files.exists(file.toPath(), NOFOLLOW_LINKS)
    private fun hash(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(131072)
            while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
    private fun atomicJson(file: File, value: JSONObject) {
        file.parentFile!!.mkdirs()
        val tmp = File(file.parentFile, ".${file.name}-${UUID.randomUUID()}")
        try {
            FileOutputStream(tmp).use { out -> out.write(value.toString().toByteArray(Charsets.UTF_8)); out.fd.sync() }
            android.system.Os.rename(tmp.absolutePath, file.absolutePath)
        } finally { tmp.delete() }
    }
    private fun delete(file: File) {
        if (!exists(file)) return
        if (Files.isSymbolicLink(file.toPath()) || !file.isDirectory) check(file.delete()) { "无法删除旧运行文件" }
        else { file.listFiles()?.forEach { delete(it) }; check(file.delete()) { "无法清理运行目录" } }
    }
    private fun move(from: File, to: File) {
        to.parentFile!!.mkdirs()
        android.system.Os.rename(from.absolutePath, to.absolutePath)
    }
    private fun id(value: String): String {
        require(value.matches(Regex("snapshot-[a-f0-9-]{36}"))) { "备份编号无效" }; return value
    }
    private fun info(ctx: Context, value: String): JSONObject = JSONObject(File(root(ctx), "${id(value)}/info.json").readText())

    @Synchronized fun status(ctx: Context): JSONObject {
        val state = index(ctx)
        val result = JSONObject()
        for (key in listOf("latest", "previous", "undo")) {
            val value = state.optString(key)
            if (value.isNotEmpty()) result.put(key, info(ctx, value))
        }
        return result
    }

    private fun nativeSignature(ctx: Context): String {
        val digest = MessageDigest.getInstance("SHA-256")
        File(ctx.applicationInfo.nativeLibraryDir).listFiles().orEmpty().sortedBy { it.name }.forEach {
            if (it.isFile && it.name.endsWith(".so")) digest.update((it.name + ":" + hash(it)).toByteArray())
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
    private fun sdk(ctx: Context): String = JSONObject(File(ctx.filesDir, "tree/node_modules/@deepseek-ai/dsh/package.json").readText()).getString("version")
    private fun validPath(value: String): String {
        require(value.isNotEmpty() && value.length <= 4096 && !value.startsWith("/") && !value.contains('\\')) { "备份路径无效" }
        require(value.split('/').none { it.isEmpty() || it == "." || it == ".." }) { "备份路径越界" }
        require(scopes.any { value == it || value.startsWith("$it/") }) { "备份包含非运行文件" }
        return value
    }
    private fun validateLink(ctx: Context, relative: String, link: String) {
        val live = File(ctx.filesDir, relative)
        val target = if (Paths.get(link).isAbsolute) File(link) else File(live.parentFile, link)
        val resolved = target.canonicalFile.toPath()
        val base = ctx.filesDir.canonicalFile.toPath()
        val nativeBase = File(ctx.applicationInfo.nativeLibraryDir).canonicalFile.toPath()
        check(resolved.startsWith(nativeBase) || (resolved.startsWith(base) &&
            scopes.any { val path = base.resolve(it); resolved == path || resolved.startsWith(path) })) {
            "插件依赖位于备份范围之外，请将插件安装到手机 DSH 的 profile 目录后再备份"
        }
    }
    private fun walk(file: File, visit: (File) -> Unit) {
        if (!exists(file)) return
        visit(file)
        if (!Files.isSymbolicLink(file.toPath()) && file.isDirectory) (file.listFiles() ?: error("运行目录无法读取，备份未完成")).sortedBy { it.name }.forEach { walk(it, visit) }
    }
    private fun mode(file: File): Int = runCatching {
        val permissions = Files.getPosixFilePermissions(file.toPath(), NOFOLLOW_LINKS)
        val ordered = PosixFilePermission.values()
        ordered.indices.fold(0) { bits, i -> if (permissions.contains(ordered[i])) bits or (1 shl (8 - i)) else bits }
    }.getOrDefault(if (file.isDirectory) 448 else 384)
    private fun chmod(file: File, value: Int) {
        Files.setPosixFilePermissions(file.toPath(), PosixFilePermission.values().filterIndexed { i, _ -> value and (1 shl (8 - i)) != 0 }.toSet())
    }

    private fun snapshot(ctx: Context, requireReady: Boolean): String {
        recoverInterruptedRestore(ctx)
        if (requireReady) {
            check(NodeRunner.binJs(ctx).isFile && File(ctx.filesDir, "dsh-home/profiles/phone/package.json").isFile) { "运行环境尚未准备好，无法备份" }
        }
        var total = 0L; var count = 0
        scopes.forEach { scope -> walk(File(ctx.filesDir, scope)) {
            count++; check(count <= MAX_FILES) { "插件文件数量超过备份上限" }
            if (!Files.isSymbolicLink(it.toPath()) && it.isFile) total += it.length()
        } }
        check(total <= MAX_BYTES && count > 0) { "运行环境超过备份上限或为空" }
        check(ctx.filesDir.usableSpace > total + RESERVE) { "手机剩余空间不足，请先释放空间" }
        val key = "snapshot-${UUID.randomUUID()}"
        val folder = File(root(ctx), key).apply { mkdirs() }
        val entries = JSONArray()
        try {
            FileOutputStream(File(folder, "payload.zip")).use { output ->
                ZipOutputStream(output.buffered()).use { zip ->
                    zip.setLevel(1)
                    scopes.forEach { scope -> walk(File(ctx.filesDir, scope)) { file ->
                        val relative = validPath(ctx.filesDir.toPath().relativize(file.toPath()).toString())
                        val row = JSONObject().put("path", relative).put("mode", mode(file))
                        when {
                            Files.isSymbolicLink(file.toPath()) -> {
                                val link = Files.readSymbolicLink(file.toPath()).toString()
                                validateLink(ctx, relative, link)
                                row.put("type", "link").put("target", link)
                            }
                            file.isDirectory -> row.put("type", "directory")
                            file.isFile -> {
                                row.put("type", "file").put("size", file.length())
                                val digest = MessageDigest.getInstance("SHA-256")
                                zip.putNextEntry(ZipEntry(relative))
                                file.inputStream().buffered().use { input ->
                                    val buffer = ByteArray(131072)
                                    while (true) { val n = input.read(buffer); if (n < 0) break; zip.write(buffer, 0, n); digest.update(buffer, 0, n) }
                                }
                                zip.closeEntry()
                                row.put("sha256", digest.digest().joinToString("") { "%02x".format(it) })
                            }
                            else -> error("插件包含无法备份的特殊文件")
                        }
                        entries.put(row)
                    } }
                }
            }
            // The ZIP has closed its stream; sync it before publishing the index.
            FileOutputStream(File(folder, "payload.zip"), true).use { it.fd.sync() }
            atomicJson(File(folder, "manifest.json"), JSONObject().put("entries", entries))
            check(File(folder, "manifest.json").length() <= 32L * 1024 * 1024) { "插件文件清单超过备份上限" }
            val payload = File(folder, "payload.zip")
            val metadata = JSONObject().put("id", key).put("format", 1).put("createdAt", System.currentTimeMillis())
                .put("appVersion", ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName)
                .put("assetVersion", File(ctx.filesDir, "dsh.version").let { if (it.exists()) it.readText().trim() else "" })
                .put("sdk", runCatching { sdk(ctx) }.getOrDefault("unknown"))
                .put("nativeSignature", nativeSignature(ctx)).put("filesRoot", ctx.filesDir.absolutePath)
                .put("nativeRoot", ctx.applicationInfo.nativeLibraryDir).put("bytes", payload.length()).put("unpackedBytes", total)
                .put("zipSha256", hash(payload)).put("manifestSha256", hash(File(folder, "manifest.json")))
            atomicJson(File(folder, "info.json"), metadata)
            return key
        } catch (error: Throwable) { delete(folder); throw error }
    }

    private fun publish(ctx: Context, state: JSONObject) {
        atomicJson(File(root(ctx), "index.json"), state)
        val keep = listOf("latest", "previous", "undo").map { state.optString(it) }.toSet()
        root(ctx).listFiles().orEmpty().filter { it.name.startsWith("snapshot-") && it.name !in keep }.forEach { delete(it) }
    }

    @Synchronized fun backup(ctx: Context): JSONObject {
        val key = snapshot(ctx, true)
        val state = index(ctx)
        if (state.optString("latest").isNotEmpty()) state.put("previous", state.getString("latest"))
        state.put("latest", key)
        publish(ctx, state)
        return info(ctx, key)
    }

    @Synchronized fun communityPlugins(ctx: Context): List<String> {
        val file = File(ctx.filesDir, "dsh-home/profiles/phone/package.json")
        val bundles = JSONObject(file.readText()).getJSONObject("dsh").getJSONObject("profile").getJSONArray("bundles")
        return (0 until bundles.length()).map { bundles.getString(it) }.distinct().filter { it !in protectedBundles }
    }

    @Synchronized fun disablePlugins(ctx: Context, selected: List<String>) {
        check(selected.isNotEmpty() && selected.size <= 32 && selected.distinct().size == selected.size &&
            selected.all { it in communityPlugins(ctx) && it.matches(Regex("(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*")) }) { "所选插件不存在或属于受保护的内置功能" }
        val file = File(ctx.filesDir, "dsh-home/profiles/phone/package.json")
        val original = file.readText(); val manifest = JSONObject(original)
        val profile = manifest.getJSONObject("dsh").getJSONObject("profile"); val bundles = profile.getJSONArray("bundles")
        val next = JSONArray(); for (i in 0 until bundles.length()) if (bundles.getString(i) !in selected) next.put(bundles.getString(i))
        backup(ctx)
        check(file.readText() == original) { "插件配置在备份中变化，未禁用，请重试" }
        profile.put("bundles", next); atomicJson(file, manifest)
    }

    private fun unpack(ctx: Context, key: String, target: File): JSONObject {
        val folder = File(root(ctx), id(key)); val metadata = info(ctx, key)
        check(metadata.getInt("format") == 1 && metadata.getString("nativeSignature") == nativeSignature(ctx)) { "备份运行库与当前 APK 不兼容，请安装匹配版本" }
        check(metadata.getString("sdk") == runCatching { sdk(ctx) }.getOrDefault(metadata.getString("sdk"))) { "备份的 DSH 核心版本不兼容" }
        check(ctx.filesDir.usableSpace > metadata.getLong("unpackedBytes") + RESERVE) { "手机空间不足，无法安全恢复" }
        val archive = File(folder, "payload.zip"); val manifest = File(folder, "manifest.json")
        check(archive.isFile && manifest.isFile && manifest.length() <= 32L * 1024 * 1024 &&
            hash(archive) == metadata.getString("zipSha256") && hash(manifest) == metadata.getString("manifestSha256")) { "备份校验失败，未修改当前环境" }
        val entries = JSONObject(manifest.readText()).getJSONArray("entries")
        check(entries.length() <= MAX_FILES)
        val paths = mutableSetOf<String>(); val directories = mutableListOf<Pair<File, Int>>()
        val links = mutableListOf<Pair<File, String>>()
        var total = 0L
        ZipFile(archive).use { zip ->
            val files = mutableSetOf<String>()
            for (i in 0 until entries.length()) {
                val row = entries.getJSONObject(i); val name = validPath(row.getString("path")); check(paths.add(name)) { "备份包含重复路径" }
                val file = File(target, name)
                when (row.getString("type")) {
                    "directory" -> { check(file.mkdirs() || file.isDirectory); directories.add(file to row.getInt("mode")) }
                    "link" -> links.add(file to row.getString("target"))
                    "file" -> {
                        files.add(name); val entry = zip.getEntry(name) ?: error("备份文件缺失")
                        val size = row.getLong("size"); check(size >= 0 && size <= MAX_BYTES)
                        file.parentFile!!.mkdirs(); val digest = MessageDigest.getInstance("SHA-256"); var copied = 0L
                        zip.getInputStream(entry).use { input -> FileOutputStream(file).use { out ->
                            val buffer = ByteArray(131072)
                            while (true) { val n = input.read(buffer); if (n < 0) break; copied += n; check(copied <= size); out.write(buffer, 0, n); digest.update(buffer, 0, n) }
                            out.fd.sync()
                        } }
                        check(copied == size && digest.digest().joinToString("") { "%02x".format(it) } == row.getString("sha256")) { "备份文件校验失败" }
                        total += copied; check(total <= MAX_BYTES); chmod(file, row.getInt("mode"))
                    }
                    else -> error("备份文件类型无效")
                }
            }
            val archiveNames = zip.entries().toList().map { it.name }; check(archiveNames.size == files.size && archiveNames.toSet() == files) { "备份压缩包结构无效" }
        }
        // Links are created only after regular files, so archive entries cannot write through a link.
        links.forEach { (file, stored) ->
            var link = stored
            for ((before, after) in listOf(metadata.getString("filesRoot") to ctx.filesDir.absolutePath,
                metadata.getString("nativeRoot") to ctx.applicationInfo.nativeLibraryDir)) {
                if (link == before || link.startsWith("$before/")) link = after + link.removePrefix(before)
            }
            validateLink(ctx, target.toPath().relativize(file.toPath()).toString(), link)
            file.parentFile!!.mkdirs(); check(!exists(file)); Files.createSymbolicLink(file.toPath(), Paths.get(link))
        }
        directories.asReversed().forEach { (file, permissions) -> chmod(file, permissions) }
        // Older JavaScript snapshots remain usable without the launcher immediately replacing them.
        File(target, "dsh.version").writeText(NodeRunner.ASSET_VERSION)
        check(File(target, "tree/node_modules/@deepseek-ai/dsh/lib/bin.js").isFile &&
            File(target, "dsh-home/profiles/phone/package.json").isFile) { "备份缺少启动文件" }
        return metadata
    }

    @Synchronized fun restore(ctx: Context, slot: String): JSONObject {
        require(slot in listOf("latest", "previous", "undo"))
        recoverInterruptedRestore(ctx)
        val selected = index(ctx).optString(slot); check(selected.isNotEmpty()) { "还没有可恢复的备份，请先快速备份" }
        val incoming = File(root(ctx), "incoming-${UUID.randomUUID()}").apply { mkdirs() }
        val old = File(root(ctx), "holding-${UUID.randomUUID()}")
        val journal = File(root(ctx), "restore-journal.json")
        try {
            val metadata = unpack(ctx, selected, incoming)
            // Keep the broken environment too, for an explicit undo. Never overwrite the selected snapshot.
            val undo = snapshot(ctx, false)
            publish(ctx, index(ctx).put("undo", undo))
            val state = JSONObject().put("incoming", incoming.name).put("holding", old.name).put("committed", false)
                .put("existed", JSONObject().also { flags -> scopes.forEach { flags.put(it, exists(File(ctx.filesDir, it))) } })
            atomicJson(journal, state)
            scopes.forEach { scope ->
                val live = File(ctx.filesDir, scope); val source = File(incoming, scope)
                if (exists(live)) move(live, File(old, scope))
                if (exists(source)) move(source, live)
            }
            atomicJson(journal, state.put("committed", true))
            delete(old); delete(incoming); check(journal.delete())
            return metadata
        } catch (error: Throwable) {
            recoverInterruptedRestore(ctx)
            delete(incoming)
            throw error
        }
    }

    /** A killed app during swaps is rolled back before the next Node launch. */
    @Synchronized fun recoverInterruptedRestore(ctx: Context) {
        val journal = File(root(ctx), "restore-journal.json")
        if (!journal.exists()) return
        val state = JSONObject(journal.readText())
        val incomingName = state.getString("incoming"); val holdingName = state.getString("holding")
        check(incomingName.matches(Regex("incoming-[a-f0-9-]{36}")) && holdingName.matches(Regex("holding-[a-f0-9-]{36}")))
        val incoming = File(root(ctx), incomingName); val old = File(root(ctx), holdingName)
        if (!state.getBoolean("committed")) scopes.asReversed().forEach { scope ->
            val live = File(ctx.filesDir, scope); val saved = File(old, scope)
            if (exists(saved)) { delete(live); move(saved, live) }
            else if (!state.getJSONObject("existed").getBoolean(scope) && !exists(File(incoming, scope))) delete(live)
        }
        delete(incoming); delete(old); check(journal.delete())
    }
}
