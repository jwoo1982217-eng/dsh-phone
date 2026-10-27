package com.dshphone

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption

internal data class CompactionFileChange(val file: File, val before: ByteArray?, val after: ByteArray)

/** The original alpha.1 private package predates the split summary helpers. */
internal object LegacyCompactionFiles {
    const val INDEX = "caf334c3293b3113969de5d49d4e91d6d9a1019fc1d9cc60ca1e6d1aee72cbee"
    const val ADAPTED = "a5834c7b84d7065d38cae309beb70c2bced260b7960df334e579e3bbd6f11807"
    val helperHashes = mapOf(
        "summary-runner.mjs" to PhoneCompactionUpgrade.FIXED,
        "summary-budget.mjs" to "52ddd7849c119c7c7028a8b5b576e390ae438c349b59ab2d92154b93bf9ca6c8",
        "summary-checkpoint.mjs" to "9f5909ccf1cc0ad17a49f5cb95da67b6c850dce5ea80df54d07296ebada0e275",
    )
    fun verify(root: File, lib: File): File {
        val index = PhoneCompactionUpgrade.physical(root, File(lib, "index.js"))
        check(PhoneCompactionUpgrade.digest(index.readBytes()) == INDEX) {
            "旧版私有压缩模块有未识别改动，原文件保持"
        }
        return index
    }
    fun plan(root: File, lib: File, helpers: Map<String, ByteArray>): List<CompactionFileChange> {
        val index = verify(root, lib)
        val old = index.readBytes()
        val text = old.toString(Charsets.UTF_8)
        val start = text.indexOf("\tconst summaryMaxTokens =", text.indexOf("async function summarizeWithLlm("))
        val end = text.indexOf("\n}\n/**", start)
        check(start >= 0 && end > start)
        val adapted = ("import {summarizeAdaptive} from \"./summary-runner.mjs\";\n" +
            text.substring(0, start) +
            "\treturn summarizeAdaptive({ctx, config, input, agent, signal, target, info, instruction: COMPACTION_INSTRUCTION, finishError, summaryText});" +
            text.substring(end)).toByteArray()
        check(PhoneCompactionUpgrade.digest(adapted) == ADAPTED)
        val additions = helperHashes.map { (name, hash) ->
            val bytes = checkNotNull(helpers[name]) { "旧版压缩兼容资源缺失，原文件保持" }
            check(PhoneCompactionUpgrade.digest(bytes) == hash)
            val file = PhoneCompactionUpgrade.physical(root, File(lib, name), required = false)
            check(!Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS)) {
                "旧版压缩目录有额外文件，原文件保持"
            }
            CompactionFileChange(file, null, bytes)
        }
        return additions + CompactionFileChange(index, old, adapted)
    }
}
