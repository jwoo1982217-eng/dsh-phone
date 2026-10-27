package com.dshphone

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.ContextWrapper
import android.os.Bundle
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.net.ServerSocket
import java.net.InetAddress
import java.util.concurrent.atomic.AtomicReference

/** Runs only inside a randomly named disposable test UID; no Node process or network is started. */
class PeerUpgradeInstrumentation : Instrumentation() {
    private val bases = listOf("tree/node_modules/dsh-peer", "dsh-home/profiles/phone/node_modules/dsh-peer")
    private val original = listOf("index.mjs", "tunnel.mjs", "relay.mjs", "page.html", "protocol.mjs")
    private val token = "11111111-2222-3333-4444-555555555555"
    private val runner = "node_modules/@deepseek-ai/dsh-compaction-basic/lib/summary-runner.mjs"
    private fun asset(name: String) = targetContext.assets.open(name).use { it.readBytes() }
    private fun put(root: File, path: String, bytes: ByteArray) = File(root,path).apply { parentFile!!.mkdirs();writeBytes(bytes) }
    private fun put(root: File, path: String, text: String) = put(root,path,text.toByteArray())
    private fun ctx(root: File) = object : ContextWrapper(targetContext) { override fun getFilesDir() = root }
    private fun protected(root: File) = listOf("dsh-home/profiles/phone/package.json", "dsh-home/profiles/phone/.dsh-purge-runtime/current.json",
        "dsh-home/profiles/phone/.dsh-purge-runtime/history/keep", "dsh-home/extensions/中文 空格工具/main.mjs", "dsh-home/storage/session.jsonl",
        "dsh-home/credentials.json", "dsh-home/skills/user/SKILL.md").associateWith { PhoneCompactionUpgrade.digest(File(root,it).readBytes()) }
    private fun seed(inputRoot: File, version: String) {
        val root=inputRoot.canonicalFile
        check(!File(root,"dsh.version").exists())
        put(root,"dsh.version",version)
        put(root,"tree/node_modules/@deepseek-ai/dsh/package.json","{\"version\":\"0.2.1-alpha.1\"}")
        put(root,"tree/node_modules/@deepseek-ai/dsh/lib/bin.js","// never execute in this fixture")
        val old = if(version=="121") asset("compaction-summary-runner.mjs") else asset("fixture-old-runner.mjs")
        put(root,"tree/$runner",old);put(root,"dsh-home/profiles/phone/$runner",old)
        bases.forEach { base -> original.forEach { name -> put(root,"$base/$name",asset("fixture-peer-old/$name")) } }
        val profile=File(root,"dsh-home/profiles/phone").canonicalFile
        val run=File(profile,".dsh-purge-runtime/$token")
        // Real installed120 has the old inline private index. 121 retains the existing validated helper chain.
        if(version=="121") put(root,run.relativeTo(root).path+"/$runner",old)
        else put(root,run.relativeTo(root).path+"/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js",asset("fixture-legacy-index.js"))
        put(root,"dsh-home/profiles/phone/.dsh-purge-runtime/current.json",JSONObject().put("owner","dsh-purge-community-private-runtime-v1")
            .put("phase","installed").put("token",token).put("profileDir",profile.path).put("runDir",run.path)
            .put("aiBase",File(run,"node_modules/@deepseek-ai").path).toString())
        put(root,"dsh-home/profiles/phone/package.json","{\"user\":true}")
        put(root,"dsh-home/profiles/phone/.dsh-purge-runtime/history/keep","private history remains")
        put(root,"dsh-home/extensions/中文 空格工具/main.mjs","custom extension remains")
        put(root,"dsh-home/storage/session.jsonl","existing synthetic session")
        put(root,"dsh-home/credentials.json","synthetic credential reference remains")
        put(root,"dsh-home/skills/user/SKILL.md","user skill remains")
        put(root,"fixture-protected.json",JSONObject(protected(root)).toString())
    }
    private fun checkNew(root: File) {
        check(File(root,"dsh.version").readText()=="122")
        val manifest=JSONObject(String(asset("remote-peer/manifest.json")))
        val rows=manifest.getJSONArray("files")
        bases.forEach { base -> for(i in 0 until rows.length()) {
            val row=rows.getJSONObject(i);check(PhoneCompactionUpgrade.digest(File(root,"$base/${row.getString("name")}").readBytes())==row.getString("sha256"))
        } }
        val saved=JSONObject(File(root,"fixture-protected.json").readText())
        protected(root).forEach { (path,sha) -> check(saved.getString(path)==sha) }
        check(PhoneCompactionUpgrade.targets(root).all { PhoneCompactionUpgrade.digest(it.readBytes())==PhoneCompactionUpgrade.FIXED })
    }
    private fun cases(root: File) {
        val c=ctx(root);val before=protected(root)
        val path="${bases.last()}/index.mjs";val f=File(root,path)
        val bytes=f.readBytes();f.writeText("unknown patch")
        check(runCatching{PhonePeerUpgrade.applyIfSupported(c,"122")}.isFailure)
        check(f.readText()=="unknown patch" && File(root,"dsh.version").readText()=="121")
        f.writeBytes(bytes)
        check(f.delete());val outside=put(root,"outside.mjs","preserve outside")
        Files.createSymbolicLink(f.toPath(),outside.toPath())
        check(runCatching{PhonePeerUpgrade.applyIfSupported(c,"122")}.isFailure)
        check(outside.readText()=="preserve outside");Files.delete(f.toPath());f.writeBytes(bytes)
        val manifest=String(asset("remote-peer/manifest.json"))
        val rows=JSONObject(manifest).getJSONArray("files")
        val payload=(0 until rows.length()).associate { i -> rows.getJSONObject(i).getString("name").let { it to asset("remote-peer/files/$it") } }
        check(runCatching{PhonePeerUpgrade.install(root,manifest,payload){error("precommit interruption")}}.isFailure)
        check(File(root,"dsh.version").readText()=="121" && f.readBytes().contentEquals(bytes))
        check(!File(root,"${bases.first()}/remote-service.mjs").exists())
        check(runCatching{PhonePeerUpgrade.install(root,manifest,payload){f.writeText("concurrent edit");error("interruption")}}.isFailure)
        check(f.readText()=="concurrent edit" && File(root,"remote-peer-upgrade-pending.json").isFile)
        check(runCatching{PhonePeerUpgrade.recover(root)}.isFailure);check(f.readText()=="concurrent edit")
        f.writeBytes(payload.getValue("index.mjs"));PhonePeerUpgrade.recover(root)
        check(f.readBytes().contentEquals(bytes) && protected(root)==before)
        PhonePeerUpgrade.install(root,manifest,payload);checkNew(root)
        val id=File(root,"remote-peer-upgrades").listFiles()!!.single { File(it,"completed.json").isFile }.name
        PhonePeerUpgrade.rollbackCommitted(root,id)
        check(f.readBytes().contentEquals(bytes) && File(root,"dsh.version").readText()=="121" && protected(root)==before)
        PhonePeerUpgrade.install(root,manifest,payload);checkNew(root)
    }
    private fun nativeClientCase() {
        val server=ServerSocket(0,8,InetAddress.getByName("127.0.0.1"))
        server.soTimeout=8000
        val origin="http://127.0.0.1:${server.localPort}"
        val failure=AtomicReference<Throwable?>()
        val requests=mutableListOf<String>()
        val serving=Thread {
            try {
                repeat(4) { index -> server.accept().use { socket ->
                    socket.soTimeout=8000
                    val input=socket.getInputStream();val raw=StringBuilder()
                    while(!raw.endsWith("\r\n\r\n")) {val b=input.read();check(b>=0 && raw.length<16384);raw.append(b.toChar())}
                    val headers=raw.toString();requests.add(headers)
                    val length=Regex("(?im)^Content-Length: ([0-9]+)\r?$").find(headers)?.groupValues?.get(1)?.toInt() ?: 0
                    val body=ByteArray(length);var offset=0
                    while(offset<length){val count=input.read(body,offset,length-offset);check(count>0);offset+=count}
                    if(index!=1) {
                        check(headers.startsWith("POST /phone-peer/manage HTTP/1.1"))
                        check(headers.contains("Origin: $origin",true))
                        val rpc=JSONObject(String(body));check(rpc.getString("method")=="manage" && rpc.getString("type")=="client-request")
                    }
                    val response=when(index) {
                        0 -> "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        1 -> "HTTP/1.1 303 See Other\r\nSet-Cookie: native=fixture; HttpOnly; Path=/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        else -> {
                            check(headers.contains("Cookie: native=fixture",true))
                            val value="""{"result":{"ok":true,"value":{"paired":true,"connected":true}}}"""
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${value.toByteArray().size}\r\nConnection: close\r\n\r\n$value"
                        }
                    }
                    socket.getOutputStream().write(response.toByteArray());socket.getOutputStream().flush()
                } }
            } catch(error:Throwable){failure.set(error)} finally{server.close()}
        }
        val calling=Thread {
            try {
                check(PeerLocalClient(origin,{"$origin/?token=synthetic"},{""}).manage("pair","synthetic-capability")==PeerStatus(true,true))
                check(PeerLocalClient(origin,{null},{"native=fixture"}).manage("reconnect",null)==PeerStatus(true,true))
            } catch(error:Throwable){failure.set(error)}
        }
        serving.start();calling.start();calling.join(20000);serving.join(20000)
        check(!calling.isAlive && !serving.isAlive)
        failure.get()?.let{throw it}
        check(requests.size==4 && requests.none{it.contains("synthetic-capability")})
    }
    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        val phase=arguments?.getString("phase").orEmpty()
        try {
            check(targetContext.packageName.startsWith("com.dshphone.peerverification.t") && targetContext.packageName!="com.dshphone")
            if(phase=="before") {
                check(NodeRunner.ASSET_VERSION=="119")
                seed(targetContext.filesDir,"119")
                seed(File(targetContext.filesDir,"old120"),"120")
                seed(File(targetContext.filesDir,"old121"),"121")
                seed(File(targetContext.filesDir,"boundary"),"121")
            } else {
                check(phase=="after" && NodeRunner.ASSET_VERSION=="122")
                // Real production NodeRunner includes recovery before its current-version early return.
                NodeRunner.ensureExtracted(targetContext);checkNew(targetContext.filesDir)
                NodeRunner.ensureExtracted(targetContext);checkNew(targetContext.filesDir)
                for(version in listOf("120","121")) {
                    val root=File(targetContext.filesDir,"old$version")
                    NodeRunner.ensureExtracted(ctx(root));checkNew(root)
                    NodeRunner.ensureExtracted(ctx(root));checkNew(root)
                }
                cases(File(targetContext.filesDir,"boundary"))
                nativeClientCase()
            }
            finish(Activity.RESULT_OK,Bundle().apply{putString("result","DSH_PEER_${phase.uppercase()}_OK")})
        } catch(error:Throwable) {
            finish(Activity.RESULT_CANCELED,Bundle().apply{putString("error",error.stackTraceToString())})
        }
    }
}
