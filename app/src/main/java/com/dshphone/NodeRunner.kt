package com.dshphone

import android.content.Context
import android.util.Log
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.net.Proxy
import java.net.HttpURLConnection
import java.nio.file.Files
import org.json.JSONObject
import org.json.JSONArray

/**
 * 手机版 dsh 运行器：复刻墨枢（com.zcode.proxy）的「壳 + 内嵌 Node」模式。
 * - Node v26.4.0（Termux 编译）改名 libnode.so 由系统释放到 nativeLibraryDir，可直接 exec；
 * - dsh 部署树（hoisted node_modules，无符号链接）与 dsh-home（含 phone profile）
 *   以 tar 形式放在 assets，首启/升级时解压到 filesDir；
 * - dsh-home/node_modules -> tree/node_modules 符号链接是启动关键：
 *   cordis 加载器从 profile 目录解析插件 bare import，必须能沿目录树走到部署树。
 */
object NodeRunner {
    private const val TAG = "dsh-phone"
    const val ASSET_VERSION = "63"
    const val GATEWAY_PORT = 8326
    const val WEB_PORT = 3080

    fun treeDir(ctx: Context) = File(ctx.filesDir, "tree")
    fun homeDir(ctx: Context) = File(ctx.filesDir, "dsh-home")
    fun tmpDir(ctx: Context) = File(ctx.filesDir, "tmp").apply { mkdirs() }
    private fun versionFile(ctx: Context) = File(ctx.filesDir, "dsh.version")
    fun binJs(ctx: Context) = File(treeDir(ctx), "node_modules/@deepseek-ai/dsh/lib/bin.js")
    fun consoleLog(ctx: Context) = File(ctx.filesDir, "dsh-console.log")

    @Synchronized
    fun ensureExtracted(ctx: Context) {
        RecoveryManager.recoverInterruptedRestore(ctx)
        val alreadyOk = runCatching {
            versionFile(ctx).readText().trim() == ASSET_VERSION
        }.getOrDefault(false) &&
            binJs(ctx).exists() &&
            File(homeDir(ctx), "profiles/phone/package.json").exists()
        if (alreadyOk) return

        Log.i(TAG, "extracting dsh assets v$ASSET_VERSION")
        // 只替换程序树。账号、令牌、会话与用户设置都在 dsh-home，升级必须保留。
        treeDir(ctx).deleteRecursively()
        treeDir(ctx).mkdirs()
        val existingHome = File(homeDir(ctx), "profiles/phone/package.json").exists()
        homeDir(ctx).mkdirs()
        extractAsset(ctx, "dsh-tree.tar", treeDir(ctx))
        if (existingHome) {
            val template = File(ctx.filesDir, "dsh-home-template")
            template.deleteRecursively()
            template.mkdirs()
            extractAsset(ctx, "dsh-home.tar", template)
            val bundledModules = File(template, "profiles/phone/node_modules")
            val installedModules = File(homeDir(ctx), "profiles/phone/node_modules")
            installedModules.mkdirs()
            bundledModules.listFiles()?.forEach { module ->
                // A scoped package directory can also contain user-installed
                // packages. Replace only the individual bundled packages.
                val packages = if (module.name.startsWith("@")) module.listFiles()?.toList().orEmpty() else listOf(module)
                packages.forEach { bundled ->
                    val target = if (module.name.startsWith("@")) File(installedModules, "${module.name}/${bundled.name}") else File(installedModules, bundled.name)
                    target.deleteRecursively()
                    check(bundled.copyRecursively(target, overwrite = true)) {
                        "Cannot update bundled module ${bundled.name}"
                    }
                }
            }
            // 添加新账号入口组合包，同时保留用户已有 profile 配置和其他组合包。
            val manifest = File(homeDir(ctx), "profiles/phone/package.json")
            val packageJson = JSONObject(manifest.readText())
            val dsh = packageJson.optJSONObject("dsh") ?: JSONObject().also { packageJson.put("dsh", it) }
            val profile = dsh.optJSONObject("profile") ?: JSONObject().also { dsh.put("profile", it) }
            val bundles = profile.optJSONArray("bundles") ?: JSONArray().also { profile.put("bundles", it) }
            val dependencies = packageJson.optJSONObject("dependencies") ?: JSONObject().also { packageJson.put("dependencies", it) }
            listOf("dsh-codearts-auth", "dsh-phone-account", "dsh-phone-qq", "@zseven-w/dsh-noema").forEach { bundle ->
                if ((0 until bundles.length()).none { bundles.optString(it) == bundle }) bundles.put(bundle)
                dependencies.put(bundle, "file:./node_modules/$bundle")
            }
            manifest.writeText(packageJson.toString(2))
            val settings = File(homeDir(ctx), "settings.yaml")
            if (!settings.exists()) File(template, "settings.yaml").copyTo(settings)
            template.deleteRecursively()
        } else {
            extractAsset(ctx, "dsh-home.tar", homeDir(ctx))
        }
        makeHomeLink(ctx)
        versionFile(ctx).writeText(ASSET_VERSION)
        Log.i(TAG, "extracted ok")
    }

    private fun extractAsset(ctx: Context, name: String, target: File) {
        val tmp = File(ctx.filesDir, name)
        ctx.assets.open(name).use { input ->
            tmp.outputStream().use { output -> input.copyTo(output, 1 shl 20) }
        }
        val p = ProcessBuilder("/system/bin/tar", "-xf", tmp.absolutePath, "-C", target.absolutePath)
        val rc = p.start().waitFor()
        tmp.delete()
        if (rc != 0) throw IllegalStateException("tar $name exit=$rc")
    }

    /** cordis 从 profile 目录向上解析 bare import，必须能走到部署树的 node_modules。 */
    private fun makeHomeLink(ctx: Context) {
        val link = File(homeDir(ctx), "node_modules")
        if (Files.exists(link.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS) &&
            !Files.isSymbolicLink(link.toPath())) {
            check(link.isDirectory) { "Home node_modules is not a directory" }
            // Some old installs have real dependencies here. Preserve user
            // plugins; the migration replaces only shipped SDK packages.
            return
        }
        Files.deleteIfExists(link.toPath())
        runCatching {
            Files.createSymbolicLink(link.toPath(), File(treeDir(ctx), "node_modules").toPath())
        }.onFailure {
            // 个别机型退回 ln -s
            ProcessBuilder("/system/bin/ln", "-sfn",
                File(treeDir(ctx), "node_modules").absolutePath, link.absolutePath).start().waitFor()
        }
        check(Files.isSymbolicLink(link.toPath())) { "Cannot link phone runtime dependencies" }
    }

    /** The launcher and isolated tool verification share the exact native paths. */
    fun prepareEnvironment(ctx: Context): Map<String, String> {
        val phoneBin = File(ctx.filesDir, "bin").apply { mkdirs() }
        for ((name, library) in mapOf("node" to "libnode.so", "bash" to "libbash.so",
            "rg" to "libdshrg.so", "landlock-run" to "libdshlandlock.so")) {
            val executable = File(ctx.applicationInfo.nativeLibraryDir, library)
            check(executable.isFile && executable.canExecute()) { "内置工具缺失：$name，请重新安装完整 APK" }
            val link = File(phoneBin, name).toPath()
            Files.deleteIfExists(link)
            Files.createSymbolicLink(link, executable.toPath())
        }
        return mapOf(
            "DSH_PHONE_ANDROID" to "1",
            "DSH_PHONE_FILES" to ctx.filesDir.absolutePath,
            "DSH_PHONE_IMAGE_SOCKET" to AndroidImageProcessor.start(),
            "DSH_PHONE_CONTROL_SOCKET" to com.dshphone.control.ControlBridge.start(ctx),
            "DSH_PHONE_NOEMA" to File(ctx.applicationInfo.nativeLibraryDir, "libnoema.so").absolutePath,
            "DSH_PHONE_FLOCK" to File(ctx.applicationInfo.nativeLibraryDir, "libdshflock.so").absolutePath,
            "DSH_PHONE_STORAGE" to android.os.Environment.getExternalStorageDirectory().absolutePath,
            "DSH_PHONE_SHELL" to File(ctx.applicationInfo.nativeLibraryDir, "libbash.so").absolutePath,
            "LD_LIBRARY_PATH" to ctx.applicationInfo.nativeLibraryDir,
            "HOME" to homeDir(ctx).absolutePath,
            "DSH_HOME" to homeDir(ctx).absolutePath,
            "TMPDIR" to tmpDir(ctx).absolutePath,
            "OPENSSL_CONF" to "/dev/null",
            "PATH" to "${phoneBin.absolutePath}:/system/bin"
        )
    }

    /** Bounded executable probes; no model request, workspace access or policy change. */
    fun toolEnvironmentReport(ctx: Context): String {
        val rows = mutableListOf<String>()
        val nativeDir = ctx.applicationInfo.nativeLibraryDir
        fun probe(library: String, vararg args: String): Boolean {
            val executable = File(nativeDir, library)
            if (!executable.isFile || !executable.canExecute()) return false
            val builder = ProcessBuilder(listOf(executable.absolutePath) + args)
            builder.environment().apply {
                put("LD_LIBRARY_PATH", nativeDir)
                put("OPENSSL_CONF", "/dev/null")
            }
            builder.redirectErrorStream(true)
            builder.redirectOutput(File("/dev/null"))
            return runCatching {
                val child = builder.start()
                try {
                    child.waitFor(3, java.util.concurrent.TimeUnit.SECONDS) && child.exitValue() == 0
                } finally {
                    if (child.isAlive) { child.destroyForcibly(); child.waitFor(1, java.util.concurrent.TimeUnit.SECONDS) }
                }
            }.getOrDefault(false)
        }
        rows.add("命令执行（Bash）：" + if (probe("libbash.so", "--version")) "可用" else "不可用，请安装完整 APK")
        rows.add("文件搜索（ripgrep）：" + if (probe("libdshrg.so", "--version")) "可用" else "不可用，请安装完整 APK")
        rows.add(if (probe("libdshlandlock.so", "--probe"))
            "命令沙箱：内核支持，按只读／工作区设置执行。"
            else "命令沙箱：本机系统未开放。命令需要申请单次授权；授权后可访问 DSH 已获 Android 权限的目录，无法限制为仅工作区。未授权不执行。")
        rows.add("文件工具：仍遵循会话中的只读／工作区限制。")
        rows.add("其他应用的私有目录仍受 Android 系统限制。")
        return rows.joinToString("\n\n")
    }

    @Synchronized
    fun start(ctx: Context): Process {
        ensureExtracted(ctx)
        makeHomeLink(ctx)
        val bin = binJs(ctx)
        require(bin.exists()) { "bin.js missing: $bin" }
        val node = File(ctx.applicationInfo.nativeLibraryDir, "libnode.so")
        val cmd = listOf(
            node.absolutePath,
            "--expose-internals",       // hmr/内部 loader 需要；node-addon-require-builtin 无 android 变体
            "--no-warnings",
            bin.absolutePath,
            "--profile", "phone", "--port", "3080",
            "--no-open"
        )
        val pb = ProcessBuilder(cmd)
        pb.environment().putAll(prepareEnvironment(ctx))
        pb.directory(treeDir(ctx))
        pb.redirectErrorStream(true)
        // Old profiles carry private copies of the SDK. They must resolve to
        // this deployment before importing any plugins, including preflight.
        val migrationScript = File(treeDir(ctx), "node_modules/dsh-phone-qq/core-migration.js")
        check(migrationScript.isFile) { "Phone core migration missing" }
        val migration = ProcessBuilder(node.absolutePath, migrationScript.absolutePath)
        migration.environment().putAll(pb.environment())
        migration.directory(treeDir(ctx))
        migration.redirectErrorStream(true)
        // Drain diagnostics to a private file while waiting. Large migration
        // reports must not fill stdout's pipe and deadlock the child process.
        val migrationLog = File.createTempFile("dsh-core-migration-", ".log", tmpDir(ctx))
        try {
            DshService.appendLog("正在检查内置运行库…")
            migration.redirectOutput(migrationLog)
            val migrationChild = migration.start()
            if (!migrationChild.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)) {
                migrationChild.destroyForcibly()
                throw IllegalStateException("Phone core migration timed out")
            }
            val output = migrationLog.readText()
            if (migrationChild.exitValue() != 0) {
                DshService.appendLog("运行库检查失败：${output.takeLast(1800)}")
                throw IllegalStateException("Phone core migration failed; original data retained")
            }
            check(output.isNotBlank()) { "运行库检查未返回结果（exit=0），请更新应用运行资源" }
            val report = try {
                JSONObject(output.trim()).getJSONObject("phoneCoreMigration")
            } catch (error: org.json.JSONException) {
                throw IllegalStateException("运行库检查返回了无效的结果", error)
            }
            val count = report.optJSONArray("locations")?.length() ?: report.getJSONArray("migrated").length()
            DshService.appendLog("运行库检查完成：SDK ${report.getString("version")}，迁移 $count 个旧模块入口")
            Log.i(TAG, output.take(3000))
        } finally {
            migrationLog.delete()
        }
        val preflightScript = File(treeDir(ctx), "node_modules/dsh-phone-qq/runtime-preflight.js")
        if (preflightScript.exists()) {
            val preflight = ProcessBuilder(node.absolutePath, preflightScript.absolutePath)
            preflight.environment().putAll(pb.environment())
            preflight.directory(treeDir(ctx))
            preflight.redirectErrorStream(true)
            runCatching {
                val child = preflight.start()
                if (!child.waitFor(20, java.util.concurrent.TimeUnit.SECONDS)) child.destroyForcibly()
                else Log.i(TAG, child.inputStream.bufferedReader().readText().take(3000))
            }.onFailure { Log.w(TAG, "runtime preflight unavailable", it) }
        }
        Log.i(TAG, "spawning node: $cmd")
        return pb.start()
    }

    fun portOpen(port: Int): Boolean = runCatching {
        Socket().use { s ->
            s.connect(InetSocketAddress("127.0.0.1", port), 400)
            true
        }
    }.getOrDefault(false)

    /** 只在工作线程调用；不用系统 HTTP 代理探测本机管理页。 */
    fun webReady(): Boolean {
        val connection = (URL("http://127.0.0.1:$WEB_PORT/")
            .openConnection(Proxy.NO_PROXY) as HttpURLConnection).apply {
            connectTimeout = 700
            readTimeout = 700
            instanceFollowRedirects = false
        }
        return try {
            (connection.responseCode == 200 && connection.contentType.orEmpty().contains("text/html")) ||
                (connection.responseCode == 401 && DshService.browserLaunchUrl != null)
        } catch (_: Exception) {
            false
        } finally {
            connection.disconnect()
        }
    }

    /** 等待 dsh 网关与 Web 管理页就绪，超时返回 false。 */
    fun awaitReady(timeoutMs: Long = 90_000): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (portOpen(GATEWAY_PORT) && portOpen(WEB_PORT)) return true
            Thread.sleep(1000)
        }
        return false
    }
}
