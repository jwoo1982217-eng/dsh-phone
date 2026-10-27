package com.dshphone

import android.app.Instrumentation
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.IBinder
import android.webkit.CookieManager
import android.webkit.WebView
import com.dshphone.browser.BrowserService
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Actual device-only fixture: no Activity, arbitrary remote host, accessibility or Shizuku call. */
object BrowserUpgradeProbe {
    private const val OWNER = "isolated_fixture"
    private lateinit var instrumentation: Instrumentation
    private lateinit var context: Context
    private var connection: ServiceConnection? = null
    private val report = JSONObject()

    fun verify(runner: Instrumentation, phase: String) {
        instrumentation = runner; context = runner.targetContext
        check(context.packageName.matches(Regex("com\\.dshphone\\.mcpupgradeverification\\.t[a-f0-9]{32}")))
        val markerFile = File(context.filesDir,"browser-cookie-marker.txt")
        val marker = if(phase=="before") UUID.randomUUID().toString().also { markerFile.writeText(it) } else markerFile.readText()
        report.put("phase",phase).put("headless",true).put("productionPackageTouched",false)
        val server = FixtureServer()
        try {
            bind() // BrowserService.onCreate sets the data suffix BEFORE CookieManager or any WebView access.
            if(phase=="before") {
                val saved=CompletableFuture<Boolean>()
                main { CookieManager.getInstance().setCookie(server.url,"dsh_upgrade_fixture=$marker; Path=/; SameSite=Lax") { saved.complete(it) } }
                check(saved.get(10,TimeUnit.SECONDS)) { "Cannot store the fixture cookie" }
                main { CookieManager.getInstance().flush() }
            }
            else check(cookie(server.url).contains("dsh_upgrade_fixture=$marker")) { "Own isolated browser cookie did not survive APK replacement" }
            report.put("cookiePreserved",phase=="after")
            val opened = call("open",JSONObject().put("url",server.url).put("viewportWidth",412).put("viewportHeight",915).put("identity","android-real"))
            val tab = opened.getJSONArray("tabs").getJSONObject(0).getString("id")
            report.put("mobile",assertProfile(tab,412,915,false))
            val switched = call("profile",JSONObject().put("tabId",tab).put("viewportWidth",1080).put("viewportHeight",1600).put("identity","windows-desktop"))
            val effective = switched.getJSONArray("tabs").getJSONObject(0).getString("effectiveIdentity")
            val desktop = assertProfile(tab,1080,1600,effective=="windows-desktop")
            desktop.put("effectiveIdentity",effective).put("profileNote",switched.getJSONArray("tabs").getJSONObject(0).optString("profileNote"))
            report.put("desktop",desktop)
            val presetState=call("profile",JSONObject().put("tabId",tab).put("viewportWidth",1280).put("viewportHeight",800).put("identity","windows-desktop"))
            val presetIdentity=presetState.getJSONArray("tabs").getJSONObject(0).getString("effectiveIdentity")
            report.put("desktopPreset1280x800",assertProfile(tab,1280,800,presetIdentity=="windows-desktop").put("effectiveIdentity",presetIdentity))
            call("profile",JSONObject().put("tabId",tab).put("viewportWidth",412).put("viewportHeight",915).put("identity","android-real"))
            report.put("mobileAfterSwitch",assertProfile(tab,412,915,false))
            val beforeTabs = call("status").getJSONArray("tabs").length()
            for(url in listOf("file:///data/local/tmp/no-fixture","content://invalid/fixture","javascript:alert(1)","http://name:pass@127.0.0.1/")) {
                check(runCatching { call("open",JSONObject().put("url",url)) }.isFailure) { "Invalid URL admitted: $url" }
            }
            check(runCatching { call("profile",JSONObject().put("tabId",tab).put("viewportWidth",239)) }.isFailure)
            check(call("status").getJSONArray("tabs").length()==beforeTabs)
            main { check(BrowserService.current!!.view("other_owner",tab)==null) }
            report.put("invalidOriginsAndOwnerRejected",true)
            main { CookieManager.getInstance().flush() }
            unbind()
            bind()
            check(call("status").getJSONArray("tabs").length()==0) { "Service restart replayed stale tabs" }
            check(cookie(server.url).contains("dsh_upgrade_fixture=$marker")) { "Service restart lost cookie" }
            val reopened=call("open",JSONObject().put("url",server.url).put("viewportWidth",412).put("viewportHeight",915))
            report.put("afterStopReopen",assertProfile(reopened.getJSONArray("tabs").getJSONObject(0).getString("id"),412,915,false))
            report.put("stopRecovery",true)
            report.put("webViewPackage",main { WebView.getCurrentWebViewPackage()?.let { "${it.packageName}/${it.versionName}" } ?: "unknown" })
            File(context.filesDir,"browser-profile-$phase.json").writeText(report.toString(2))
            runner.sendStatus(0,Bundle().apply { putString("stream","DSH_BROWSER_PROFILE_${phase.uppercase()}_OK ${report}\n") })
        } catch(error:Throwable) {
            report.put("error",error.message ?: error.javaClass.simpleName)
            File(context.filesDir,"browser-profile-$phase.json").writeText(report.toString(2))
            runner.sendStatus(0,Bundle().apply { putString("stream","DSH_BROWSER_PROFILE_FAILED ${report}\n") })
            throw error
        } finally { runCatching { unbind() }; server.close() }
    }
    private fun bind() {
        val ready=CompletableFuture<Unit>()
        val next=object:ServiceConnection {
            override fun onServiceConnected(name:ComponentName?,service:IBinder?) { ready.complete(Unit) }
            override fun onServiceDisconnected(name:ComponentName?) {}
        }
        main { check(context.bindService(Intent(context,BrowserService::class.java),next,Context.BIND_AUTO_CREATE)) }
        connection=next;ready.get(15,TimeUnit.SECONDS)
        main { check(BrowserService.current!=null) }
    }
    private fun unbind() {
        val previous=connection ?: return;connection=null
        main { context.unbindService(previous);context.stopService(Intent(context,BrowserService::class.java)) }
        val until=System.nanoTime()+TimeUnit.SECONDS.toNanos(10)
        while(main { BrowserService.current!=null }) { check(System.nanoTime()<until){"BrowserService did not stop"};Thread.sleep(50) }
    }
    private fun cookie(url:String)=main { CookieManager.getInstance().getCookie(url) ?: "" }
    private fun <T> main(action:()->T):T {
        val result=CompletableFuture<T>()
        instrumentation.runOnMainSync { try { result.complete(action()) } catch(error:Throwable) { result.completeExceptionally(error) } }
        return result.get(20,TimeUnit.SECONDS)
    }
    private fun call(method:String,args:JSONObject=JSONObject()):JSONObject {
        val result=CompletableFuture<JSONObject>()
        main { try { BrowserService.current!!.call(OWNER,method,args) { value,error->if(error!=null)result.completeExceptionally(error) else result.complete(value!!) } } catch(error:Throwable) { result.completeExceptionally(error) } }
        return result.get(20,TimeUnit.SECONDS)
    }
    private fun metrics(tab:String):JSONObject {
        val result=CompletableFuture<JSONObject>()
        main {
            val view=BrowserService.current!!.view(OWNER,tab)!!
            view.evaluateJavascript("JSON.stringify({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,ua:navigator.userAgent,uaData:navigator.userAgentData?navigator.userAgentData.toJSON():null,headers:window.__fixtureHeaders||null,ready:document.readyState})") { raw ->
                try { result.complete(JSONObject(JSONTokener(raw).nextValue().toString()).put("layoutWidth",view.width).put("layoutHeight",view.height)) } catch(error:Throwable) { result.completeExceptionally(error) }
            }
        }
        return result.get(10,TimeUnit.SECONDS)
    }
    private fun assertProfile(tab:String,width:Int,height:Int,desktop:Boolean):JSONObject {
        val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);var observed=JSONObject()
        do {
            observed=metrics(tab)
            if(!observed.isNull("headers") && kotlin.math.abs(observed.optDouble("width")-width)<=1.1 && kotlin.math.abs(observed.optDouble("height")-height)<=1.1) break
            Thread.sleep(150)
        } while(System.nanoTime()<deadline)
        observed.put("requestedWidth",width).put("requestedHeight",height)
        report.put("lastMetrics",observed)
        check(kotlin.math.abs(observed.optDouble("width")-width)<=1.1 && kotlin.math.abs(observed.optDouble("height")-height)<=1.1) { "Actual viewport differs: requested $width x $height, observed $observed" }
        val headers=observed.getJSONObject("headers")
        val ua=observed.getString("ua");check(headers.getString("user-agent")==ua) { "HTTP and JS User-Agent disagree" }
        val ch=observed.optJSONObject("uaData")
        if(desktop) {
            check(ua.contains("Windows NT 10.0")&&!ua.contains("Android")) { "Desktop UA inconsistent" }
            check(ch!=null&&ch.getString("platform")=="Windows"&&!ch.getBoolean("mobile")) { "Desktop JS UA-CH inconsistent: $ch" }
            check(headers.optString("sec-ch-ua-platform")=="\"Windows\""&&headers.optString("sec-ch-ua-mobile")=="?0") { "Desktop HTTP UA-CH inconsistent: $headers" }
        } else {
            check(ua.contains("Android")) { "Mobile UA not restored" }
            if(ch!=null)check(ch.getString("platform")=="Android"&&ch.getBoolean("mobile")) { "Mobile JS UA-CH inconsistent" }
            if(headers.has("sec-ch-ua-platform"))check(headers.getString("sec-ch-ua-platform")=="\"Android\"")
            if(headers.has("sec-ch-ua-mobile"))check(headers.getString("sec-ch-ua-mobile")=="?1")
        }
        return observed
    }
    private class FixtureServer:AutoCloseable {
        private val server=ServerSocket(0,16,InetAddress.getByName("127.0.0.1"))
        val url="http://127.0.0.1:${server.localPort}/page"
        private val thread=Thread({
            while(!server.isClosed)runCatching {
                server.accept().use { socket ->
                    socket.soTimeout=5000
                    val input=socket.getInputStream().bufferedReader();val request=input.readLine() ?: return@use
                    val headers=JSONObject();while(true) { val line=input.readLine() ?: break;if(line.isEmpty())break;val split=line.indexOf(':');if(split>0)headers.put(line.substring(0,split).lowercase(),line.substring(split+1).trim()) }
                    val isHeaders=request.split(' ').getOrNull(1)?.startsWith("/headers")==true
                    val body=if(isHeaders)headers.toString() else """<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated profile fixture</title></head><body style="margin:0"><p>synthetic local browser fixture</p><script>fetch('/headers',{cache:'no-store'}).then(r=>r.json()).then(x=>window.__fixtureHeaders=x);</script></body></html>"""
                    val data=body.toByteArray(StandardCharsets.UTF_8)
                    val response="HTTP/1.1 200 OK\r\nContent-Type: ${if(isHeaders) "application/json" else "text/html"}; charset=utf-8\r\nContent-Length: ${data.size}\r\nCache-Control: no-store\r\nAccept-CH: Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Full-Version-List\r\nConnection: close\r\n\r\n"
                    socket.getOutputStream().write(response.toByteArray(StandardCharsets.UTF_8));socket.getOutputStream().write(data);socket.getOutputStream().flush()
                }
            }
        },"isolated-profile-http").apply { isDaemon=true;start() }
        override fun close() { server.close();thread.join(1000) }
    }
}
