package com.dshphone

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import java.io.File
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/** Two real APK versions in a disposable UID, never com.dshphone. */
class McpUpgradeInstrumentation : Instrumentation() {
    private var phase = ""
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); phase=arguments?.getString("phase") ?: ""; start() }
    override fun onStart() {
        try {
            val ctx=targetContext
            check(ctx.packageName.startsWith("com.dshphone.mcpupgradeverification."))
            val home=NodeRunner.homeDir(ctx)
            if(phase=="before") {
                NodeRunner.ensureExtracted(ctx)
                val source=File(NodeRunner.treeDir(ctx),"media").apply{mkdirs()}
                ctx.assets.open("fixture-server.mjs").use { input->File(source,"server.mjs").outputStream().use{input.copyTo(it)} }
                File(source,"marker.mjs").writeText("export const marker='fixture-media-ok';")
                val row=JSONObject().put("id","media").put("transport","stdio").put("enabled",true)
                    .put("command",File(ctx.applicationInfo.nativeLibraryDir,"libnode.so").absolutePath)
                    .put("args",org.json.JSONArray().put(File(source,"server.mjs").absolutePath))
                    .put("cwd",NodeRunner.treeDir(ctx).absolutePath)
                File(home,"storage/mcp-manager").mkdirs()
                File(home,"storage/mcp-manager/config.json").writeText(JSONObject().put("version",1).put("revision",5)
                    .put("servers",org.json.JSONArray().put(row)).toString())
                File(home,"native-before.txt").writeText(row.getString("command"))
                File(home,"fixture-env.json").writeText(JSONObject().put("LD_LIBRARY_PATH",ctx.applicationInfo.nativeLibraryDir)
                    .put("MEDIA_FIXTURE_KEEP","preserved").toString())
                check(runServer(false).getString("call")=="fixture-media-ok")
                // Adjacent failure: unsafe link must not destroy the old tree.
                java.nio.file.Files.createSymbolicLink(File(source,"outside").toPath(),File(ctx.cacheDir,"outside").apply{mkdirs()}.toPath())
            } else {
                check(phase=="after")
                val config=File(home,"storage/mcp-manager/config.json")
                val before=config.readBytes()
                check(runCatching{NodeRunner.ensureExtracted(ctx)}.isFailure)
                check(before.contentEquals(config.readBytes()))
                check(File(NodeRunner.treeDir(ctx),"media/server.mjs").isFile)
                check(File(ctx.filesDir,"dsh.version").readText()==ctx.assets.open("before-version.txt").bufferedReader().use{it.readText()})
                java.nio.file.Files.delete(File(NodeRunner.treeDir(ctx),"media/outside").toPath())
                NodeRunner.ensureExtracted(ctx)
                val row=JSONObject(config.readText()).getJSONArray("servers").getJSONObject(0)
                check(row.getJSONArray("args").getString(0).startsWith("\$DSH_HOME/extensions/mcp/"))
                check(!File(NodeRunner.treeDir(ctx),"media").exists())
                val savedEnv=File(home,"fixture-env.json").readBytes()
                val staleError=runCatching{runServer(true,false)}.exceptionOrNull()
                check(staleError?.message?.contains("CANNOT LINK EXECUTABLE")==true){"Old saved loader path did not reproduce the Android failure"}
                sendStatus(0,Bundle().apply{putString("stream","REPRODUCED_STALE_LD_LIBRARY_PATH\n")})
                val result=runServer(true)
                check(result.getString("call")=="fixture-media-ok")
                check(result.getJSONArray("tools").length()==3)
                // Launch uses this APK even though durable config retains old node.
                check(File(home,"native-before.txt").readText()!=File(ctx.applicationInfo.nativeLibraryDir,"libnode.so").absolutePath)
                check(result.getBoolean("currentNode"))
                check(result.getBoolean("currentLibraryDir"))
                check(result.getString("preservedVariable")=="preserved")
                check(savedEnv.contentEquals(File(home,"fixture-env.json").readBytes()))
                check(File(ctx.filesDir,"dsh.version").readText()==NodeRunner.ASSET_VERSION)
                NodeRunner.ensureExtracted(ctx)
                check(runServer(true).getString("call")=="fixture-media-ok")
            }
            finish(Activity.RESULT_OK,Bundle().apply{putString("stream","DSH_MCP_UPGRADE_${phase.uppercase()}_OK\n")})
        } catch(error:Throwable) {finish(Activity.RESULT_CANCELED,Bundle().apply{putString("stream","DSH_MCP_UPGRADE_FAILED: ${error.javaClass.simpleName}: ${error.message}\n")})}
    }
    private fun runServer(resolve:Boolean,normalizeEnvironment:Boolean=true):JSONObject {
        val ctx=targetContext
        val script="""
            const fs=require('node:fs'),{spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
            (async()=>{
              const home=process.env.DSH_HOME;
              const row=JSON.parse(fs.readFileSync(home+'/storage/mcp-manager/config.json')).servers[0];
              const launch=${if(resolve) "(await import(pathToFileURL(process.env.DSH_PHONE_FILES+'/tree/node_modules/dsh-peer/mcp-manager/launch.mjs'))).stdioLaunch(row,home)" else "row"};
              const saved=JSON.parse(fs.readFileSync(home+'/fixture-env.json'));
              const env=${if(resolve && normalizeEnvironment) "(await import(pathToFileURL(process.env.DSH_PHONE_FILES+'/tree/node_modules/dsh-peer/mcp-manager/launch.mjs'))).stdioEnvironment(launch,process.env,saved)" else "{...process.env,...saved}"};
              const child=spawn(launch.command,launch.args,{cwd:launch.cwd,env,stdio:['pipe','pipe','pipe']});
              const replies=[],timer=setTimeout(()=>{child.kill('SIGKILL');process.exitCode=1;},10000);
              child.on('error',()=>{clearTimeout(timer);process.exitCode=1;});
              child.on('close',code=>{if(replies.length!==3){clearTimeout(timer);process.exitCode=1;}});
              let raw='';child.stdout.on('data',chunk=>{raw+=chunk;while(raw.includes('\n')){const n=raw.indexOf('\n');replies.push(JSON.parse(raw.slice(0,n)));raw=raw.slice(n+1);}
                if(replies.length===3){clearTimeout(timer);child.kill();console.log(JSON.stringify({tools:replies[1].result.tools.map(x=>x.name),call:replies[2].result.content[0].text,currentNode:launch.command===process.execPath,currentLibraryDir:env.LD_LIBRARY_PATH===require('node:path').dirname(process.execPath),preservedVariable:env.MEDIA_FIXTURE_KEEP}));}
              });child.stderr.pipe(process.stderr);child.stdin.on('error',()=>{});
              for(const [id,method,params] of [[1,'initialize',{}],[2,'tools/list',{}],[3,'tools/call',{name:'generate_image',arguments:{}}]]) child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
            })();
        """.trimIndent()
        val log=File(ctx.cacheDir,"mcp-wire.log")
        val builder=ProcessBuilder(File(ctx.applicationInfo.nativeLibraryDir,"libnode.so").absolutePath,"-e",script)
        builder.environment().putAll(NodeRunner.prepareEnvironment(ctx))
        builder.redirectErrorStream(true).redirectOutput(log)
        val child=builder.start()
        check(child.waitFor(15,TimeUnit.SECONDS)){"MCP wire timeout"}
        check(child.exitValue()==0){"MCP wire failed: "+log.readText().takeLast(800)}
        return JSONObject(log.readText().trim())
    }
}
