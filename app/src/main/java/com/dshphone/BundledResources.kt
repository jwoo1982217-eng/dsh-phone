package com.dshphone

import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** APK resources are stored once, then materialized before any runtime swap. */
internal object BundledResources {
    fun hydrate(tree: File, template: File): Int {
        val manifest = File(template, ".shared-runtime-files.json")
        if (!manifest.exists()) return 0
        val data = JSONObject(manifest.readText())
        check(data.getInt("version") == 1) { "Unsupported shared resource manifest" }
        val files = data.getJSONArray("files")
        for (index in 0 until files.length()) {
            val row = files.getJSONObject(index)
            val sourceName = row.getString("source")
            val targetName = row.getString("target")
            check(sourceName.startsWith("node_modules/") && targetName.startsWith("profiles/phone/node_modules/")) {
                "Shared resource outside bundled modules"
            }
            val source = child(tree, sourceName)
            val target = child(template, targetName)
            check(source.isFile && source.length() == row.getLong("bytes")) { "Shared resource missing or truncated" }
            check(!target.exists()) { "Shared resource target already exists" }
            check(target.parentFile!!.isDirectory || target.parentFile!!.mkdirs())
            val stage = File(target.parentFile, target.name + ".hydrate-stage")
            check(stage.createNewFile()) { "Shared resource staging conflict" }
            try {
                val digest = MessageDigest.getInstance("SHA-256")
                source.inputStream().use { input ->
                    stage.outputStream().use { output ->
                        val buffer = ByteArray(65536)
                        while (true) {
                            val size = input.read(buffer)
                            if (size < 0) break
                            digest.update(buffer, 0, size)
                            output.write(buffer, 0, size)
                        }
                    }
                }
                val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
                check(hash == row.getString("sha256")) { "Shared resource checksum mismatch" }
                check(stage.renameTo(target)) { "Cannot materialize shared resource" }
            } finally {
                stage.delete()
            }
        }
        check(manifest.delete()) { "Cannot finish shared resource preparation" }
        return files.length()
    }

    private fun child(root: File, relative: String): File {
        check(!File(relative).isAbsolute && relative.split('/').none { it == ".." || it == "." || it.isEmpty() }) {
            "Invalid shared resource path"
        }
        val result = File(root, relative).canonicalFile
        check(result.path.startsWith(root.canonicalPath + File.separator)) { "Shared resource path escaped" }
        return result
    }
}
