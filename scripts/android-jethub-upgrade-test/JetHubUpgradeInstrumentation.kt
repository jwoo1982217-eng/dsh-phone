package com.dshphone

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import java.io.File
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/** 完整手机核心与实际私有配置图，在独立UID验证；不触碰正式DSH。 */
class JetHubUpgradeInstrumentation : Instrumentation() {
    private var phase = ""
    override fun onCreate(args: Bundle?) { super.onCreate(args); phase=args?.getString("phase")?:"";start() }
    private fun hash(file: File)=MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString(""){"%02x".format(it.toInt() and 255)}
    override fun onStart() {
        val ctx=targetContext
        try {
            check(ctx.packageName.startsWith("com.dshphone.jethubverification."))
            val home=NodeRunner.homeDir(ctx)
            if(phase=="before") {
                NodeRunner.ensureExtracted(ctx)
                for(name in listOf("fixture-profile.bin","fixture-extra.bin")) {
                    val file=File(ctx.cacheDir,name)
                    ctx.assets.open(name).use { input->file.outputStream().use{input.copyTo(it)} }
                    val process=ProcessBuilder("/system/bin/tar","-xzf",file.path,"-C",ctx.applicationInfo.dataDir).start()
                    check(process.waitFor()==0)
                }
                // 只改隔离副本的位置字符串，私有人设、工具和启动recipe保持。
                home.walkTopDown().filter { it.isFile && !java.nio.file.Files.isSymbolicLink(it.toPath()) && it.extension in listOf("json","js","mjs","yml","yaml","md") }.forEach { f->
                    val text=f.readText();val next=text.replace("/data/user/0/com.dshphone/files/",ctx.filesDir.path+"/").replace("/data/data/com.dshphone/files/",ctx.filesDir.path+"/")
                    if(text!=next)f.writeText(next)
                }
                File(home,"fixture-user-data.txt").writeText("keep independent data")
                File(NodeRunner.treeDir(ctx),"custom-user-tool.js").writeText("preserve code outside JetHub")
                File(home,"profiles/phone/node_modules/dsh-our-free-model/fixture-private-extra.js").writeText("keep independent plugin")
                File(ctx.filesDir,"credentials-before.sha").writeText(hash(File(home,".credentials.yaml")))
                File(ctx.filesDir,"accounts-before.json").writeText(runCore())
                val conflict=File(home,"profiles/phone/node_modules/dsh-providers-hub").apply{mkdirs()}
                File(conflict,"user-conflict.txt").writeText("retain conflict")
            } else {
                check(phase=="after")
                val oldMarker=File(ctx.filesDir,"dsh.version").readText()
                check(runCatching { NodeRunner.ensureExtracted(ctx) }.isFailure)
                check(File(ctx.filesDir,"dsh.version").readText()==oldMarker)
                val conflict=File(home,"profiles/phone/node_modules/dsh-providers-hub")
                check(File(conflict,"user-conflict.txt").readText()=="retain conflict")
                File(conflict,"user-conflict.txt").delete();check(conflict.delete())
                NodeRunner.ensureExtracted(ctx)
                check(File(home,"fixture-user-data.txt").readText()=="keep independent data")
                check(File(NodeRunner.treeDir(ctx),"custom-user-tool.js").readText()=="preserve code outside JetHub")
                check(File(home,"profiles/phone/node_modules/dsh-our-free-model/fixture-private-extra.js").readText()=="keep independent plugin")
                val accounts=runCore()
                check(JSONObject(accounts).toString()==JSONObject(File(ctx.filesDir,"accounts-before.json").readText()).toString()) {"Account identity/order/enabled changed"}
                check(hash(File(home,".credentials.yaml"))==File(ctx.filesDir,"credentials-before.sha").readText()) {"Fixture credentials changed"}
                NodeRunner.ensureExtracted(ctx)
                check(File(ctx.filesDir,"dsh.version").readText()=="119")
            }
            finish(Activity.RESULT_OK,Bundle().apply{putString("stream","DSH_JETHUB_${phase.uppercase()}_OK\n")})
        } catch(e:Throwable) {
            finish(Activity.RESULT_CANCELED,Bundle().apply{putString("stream","DSH_JETHUB_FAILED ${e.javaClass.simpleName}: ${e.message}\n")})
        }
    }
    private fun runCore():String {
        val ctx=targetContext;val home=NodeRunner.homeDir(ctx)
        val blocker=File(ctx.cacheDir,"block-external.mjs")
        blocker.writeText("""
            import net from 'node:net';import cp from 'node:child_process';
            const original=net.Socket.prototype.connect;
            net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0];const host=first&&typeof first==='object'?first.host:typeof first==='number'?args[1]:undefined;
              if(typeof host==='string'&&!['localhost','::1','127.0.0.1','0.0.0.0'].includes(host))throw Error('FIXTURE_EXTERNAL_NETWORK_BLOCKED');return Reflect.apply(original,this,args)};
            for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=()=>{throw Error('FIXTURE_CHILD_PROCESS_BLOCKED')};
        """.trimIndent())
        val log=File(ctx.cacheDir,"core-$phase.private.log")
        val builder=ProcessBuilder(File(ctx.applicationInfo.nativeLibraryDir,"libnode.so").path,
            "--expose-internals","--no-warnings","--import",blocker.path,NodeRunner.binJs(ctx).path,
            "--profile","phone","--host","127.0.0.1","--port","49083","--no-open")
        builder.environment().putAll(NodeRunner.prepareEnvironment(ctx))
        builder.environment().put("DSH_JET_HUB_STATE_DIR",File(home,"jet-hub").path)
        builder.environment().put("DSH_OPENAI_GATEWAY_PORT","49326")
        builder.environment().put("DSH_OPENAI_GATEWAY_HOST","127.0.0.1")
        builder.redirectErrorStream(true).redirectOutput(log)
        val child=builder.start()
        try {
            val end=System.currentTimeMillis()+85000
            var entry:String?=null
            while(System.currentTimeMillis()<end&&child.isAlive) {
                entry=Regex("dsh web: (http://127\\.0\\.0\\.1:49083/\\?token=\\S+)").find(log.readText())?.groupValues?.get(1)
                if(entry!=null)break
                Thread.sleep(300)
            }
            check(entry!=null) {"Isolated core failed; see private log (${if(child.isAlive) "timeout" else child.exitValue()})"}
            val connection=URL(entry).openConnection(Proxy.NO_PROXY) as HttpURLConnection
            connection.instanceFollowRedirects=false;connection.connectTimeout=5000;connection.readTimeout=5000
            connection.responseCode
            val cookie=connection.headerFields.filterKeys{it?.equals("Set-Cookie",true)==true}.values.flatten().joinToString("; "){it.substringBefore(';')}
            connection.disconnect();check(cookie.isNotBlank())
            val summary=JSONObject()
            for(provider in listOf("codearts","buddy","workbuddy","zcode","lobsterai")) {
                val result=rpc(cookie,"account.list",JSONObject().put("provider",provider))
                check(result.getBoolean("ok")) {"Account RPC failed for $provider"}
                val accounts=result.getJSONObject("value").getJSONArray("accounts");val ids=JSONArray()
                for(i in 0 until accounts.length()) {val a=accounts.getJSONObject(i);ids.put(JSONObject().put("id",a.getString("id")).put("enabled",a.getBoolean("enabled")).put("credentialRef",a.optString("credentialRef")))}
                summary.put(provider,ids)
            }
            check(!rpc(cookie,"fixture-invalid-method",JSONObject()).getBoolean("ok"))
            check(rpc(cookie,"account.list",JSONObject().put("provider","codearts")).getBoolean("ok"))
            // 通过真实Node解析，两个名称必须复用同一份模块。
            if(phase=="after") {
                val code="""const {createRequire}=require('module');const r=createRequire(process.env.DSH_HOME+'/profiles/phone/package.json');if(r.resolve('dsh-codearts-auth')!==r.resolve('dsh-providers-hub'))process.exit(3);console.log('ALIASES_SAME_MODULE');"""
                val probe=ProcessBuilder(File(ctx.applicationInfo.nativeLibraryDir,"libnode.so").path,"-e",code)
                probe.environment().putAll(NodeRunner.prepareEnvironment(ctx));probe.redirectErrorStream(true)
                val p=probe.start();val output=p.inputStream.bufferedReader().readText();check(p.waitFor()==0&&output.contains("ALIASES_SAME_MODULE"))
            }
            return summary.toString()
        } finally {child.destroy();if(!child.waitFor(5,TimeUnit.SECONDS))child.destroyForcibly()}
    }
    private fun rpc(cookie:String,method:String,payload:JSONObject):JSONObject {
        val c=URL("http://127.0.0.1:49083/jet-hub/manage").openConnection(Proxy.NO_PROXY) as HttpURLConnection
        c.requestMethod="POST";c.doOutput=true;c.connectTimeout=5000;c.readTimeout=15000
        c.setRequestProperty("Content-Type","application/json");c.setRequestProperty("Origin","http://127.0.0.1:49083");c.setRequestProperty("Cookie",cookie)
        val body=JSONObject().put("type","client-request").put("rpcId","fixture-${System.nanoTime()}").put("method","manage").put("payload",JSONObject().put("method",method).put("payload",payload))
        c.outputStream.use{it.write(body.toString().toByteArray())}
        check(c.responseCode==200);val data=JSONObject(c.inputStream.bufferedReader().readText());c.disconnect();return data.getJSONObject("result")
    }
}
