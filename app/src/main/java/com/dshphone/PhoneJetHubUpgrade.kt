package com.dshphone

import android.content.Context
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.MessageDigest
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** 117→119只发布JetHub两处程序，保留其它热补丁、私有SDK和全部用户资料。 */
internal object PhoneJetHubUpgrade {
    private val locations = listOf("tree/node_modules/dsh-codearts-auth", "dsh-home/profiles/phone/node_modules/dsh-codearts-auth")
    private fun journal(files: File) = File(files, "jethub-upgrade-pending.json")
    private fun aliases(files: File) = locations.map { File(File(files, it).parentFile, "dsh-providers-hub") }
    private fun publish(file: File, text: String) {
        val next=File(file.parentFile,file.name+".next")
        next.outputStream().use { it.write(text.toByteArray());it.fd.sync() }
        check(next.renameTo(file)) { "无法发布JetHub升级日志" }
    }
    internal fun fingerprint(directory: File): String {
        check(directory.isDirectory && !Files.isSymbolicLink(directory.toPath()))
        val hash=MessageDigest.getInstance("SHA-256")
        directory.walkTopDown().sortedBy{it.relativeTo(directory).path}.forEach { f ->
            check(!Files.isSymbolicLink(f.toPath())) { "JetHub包包含独立链接，原文件保持" }
            if(f.isFile()) {
                hash.update(f.relativeTo(directory).path.toByteArray());hash.update(0.toByte())
                f.inputStream().use { input ->val buffer=ByteArray(65536);while(true){val n=input.read(buffer);if(n<0)break;hash.update(buffer,0,n)} }
                hash.update(0.toByte())
            }
        }
        return hash.digest().joinToString(""){"%02x".format(it.toInt() and 255)}
    }
    fun recover(files: File) {
        val record=journal(files)
        if(!record.isFile)return
        val j=JSONObject(record.readText())
        check(j.getInt("format")==1 && j.getString("id").matches(Regex("[0-9a-f-]{36}")))
        val backup=File(files,"jethub-upgrades/"+j.getString("id"))
        if(j.optBoolean("committed")) {
            check(record.renameTo(File(backup,"completed.json")))
            return
        }
        val rows=j.getJSONArray("packages")
        check(rows.length()==locations.size)
        // 先校验所有位置，再恢复；遇到用户并发改码时拒绝覆盖。
        for(i in locations.indices) {
            val old=File(backup,"package-$i");val target=File(files,locations[i]);val row=rows.getJSONObject(i)
            if(old.exists()) {
                check(fingerprint(old)==row.getString("old"))
                check(!target.exists() || fingerprint(target)==row.getString("new")) { "JetHub已有并发修改，停止自动回退" }
            } else check(fingerprint(target)==row.getString("old"))
        }
        val created=j.getJSONArray("createdAliases")
        for(i in aliases(files).indices) if(created.getBoolean(i)) {
            val link=aliases(files)[i].toPath()
            if(Files.exists(link,LinkOption.NOFOLLOW_LINKS)) {
                check(Files.isSymbolicLink(link) && Files.readSymbolicLink(link).toString()=="dsh-codearts-auth")
                Files.delete(link)
            }
        }
        for(i in locations.indices.reversed()) {
            val old=File(backup,"package-$i");val target=File(files,locations[i])
            if(old.exists()) {if(target.exists())check(target.deleteRecursively());check(old.renameTo(target))}
        }
        publish(File(files,"dsh.version"),"117")
        check(record.renameTo(File(backup,"restored.json")))
    }
    internal fun install(files: File, stagedTree: File, stagedHome: File, beforeCommit: () -> Unit = {}) {
        PhoneJetHubAlias.preflight(files)
        check(File(files,"dsh.version").readText().trim()=="117")
        val sources=listOf(File(stagedTree,"node_modules/dsh-codearts-auth"),File(stagedHome,"profiles/phone/node_modules/dsh-codearts-auth"))
        val rows=JSONArray()
        for(i in locations.indices) {
            val target=File(files,locations[i])
            check(target.canonicalPath.startsWith(files.canonicalPath+File.separator))
            val next=JSONObject(File(sources[i],"package.json").readText())
            check(next.getString("name")=="dsh-providers-hub" && next.getString("version")=="0.2.1-rc.2")
            rows.put(JSONObject().put("old",fingerprint(target)).put("new",fingerprint(sources[i])))
        }
        val id=UUID.randomUUID().toString();val backup=File(files,"jethub-upgrades/$id");check(backup.mkdirs())
        val created=JSONArray();aliases(files).forEach{created.put(!Files.exists(it.toPath(),LinkOption.NOFOLLOW_LINKS))}
        val j=JSONObject().put("format",1).put("id",id).put("packages",rows).put("createdAliases",created).put("committed",false)
        publish(journal(files),j.toString())
        for(i in locations.indices) {
            val target=File(files,locations[i]);check(target.renameTo(File(backup,"package-$i")))
            check(sources[i].renameTo(target))
        }
        PhoneJetHubAlias.prepare(files)
        beforeCommit()
        publish(File(files,"dsh.version"),"119")
        j.put("committed",true);publish(journal(files),j.toString());recover(files)
    }
    fun applyIfSupported(ctx: Context, targetVersion: String): Boolean {
        val files=ctx.filesDir
        if(targetVersion!="119" || !File(files,"dsh.version").isFile || File(files,"dsh.version").readText().trim()!="117")return false
        val core=File(files,"tree/node_modules/@deepseek-ai/dsh/package.json")
        check(core.isFile && JSONObject(core.readText()).getString("version")=="0.2.1-alpha.1") { "本次JetHub更新要求已验证的alpha.1核心" }
        val stage=File(files,"jethub-prepared");if(stage.exists())check(stage.deleteRecursively());check(stage.mkdirs())
        val tree=File(stage,"tree").apply{mkdirs()};val home=File(stage,"home").apply{mkdirs()}
        try {
            NodeRunner.extractAsset(ctx,"dsh-tree.tar",tree);NodeRunner.extractAsset(ctx,"dsh-home.tar",home)
            BundledResources.hydrate(tree,home)
            install(files,tree,home)
            return true
        } finally {stage.deleteRecursively()}
    }
}
