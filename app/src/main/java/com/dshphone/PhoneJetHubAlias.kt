package com.dshphone

import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption

/** 新旧 JetHub 名称共享同一实体，避免 OFM 与独立插件注册两套服务。 */
internal object PhoneJetHubAlias {
    private const val LEGACY = "dsh-codearts-auth"
    private const val CURRENT = "dsh-providers-hub"

    fun preflight(filesDir: File) {
        for (modules in moduleDirectories(filesDir)) validateAlias(modules)
    }

    fun prepare(filesDir: File) {
        preflight(filesDir)
        for (modules in moduleDirectories(filesDir)) {
            val source = File(modules, LEGACY)
            val manifest = File(source, "package.json")
            if (!manifest.isFile) continue
            if (JSONObject(manifest.readText()).optString("name") != CURRENT) continue
            check(!Files.isSymbolicLink(source.toPath())) { "JetHub 主目录不能是其他位置的链接" }
            val alias = File(modules, CURRENT).toPath()
            if (!Files.exists(alias, LinkOption.NOFOLLOW_LINKS)) {
                Files.createSymbolicLink(alias, File(LEGACY).toPath())
            }
            check(alias.toRealPath() == source.toPath().toRealPath()) { "JetHub 名称兼容链接不一致" }
        }
    }

    private fun validateAlias(modules: File) {
        val alias = File(modules, CURRENT).toPath()
        if (!Files.exists(alias, LinkOption.NOFOLLOW_LINKS)) return
        check(Files.isSymbolicLink(alias)) { "已有独立同名 JetHub，请先合并；原文件保持" }
        val target = alias.parent.resolve(Files.readSymbolicLink(alias)).normalize()
        check(target == File(modules, LEGACY).toPath().normalize()) { "已有 JetHub 链接指向其他位置；原文件保持" }
    }

    private fun moduleDirectories(filesDir: File) = listOf(
        File(filesDir, "tree/node_modules"),
        File(filesDir, "dsh-home/profiles/phone/node_modules")
    )
}
