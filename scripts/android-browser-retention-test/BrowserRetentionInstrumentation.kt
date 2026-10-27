package com.dshphone

import android.app.Activity
import android.app.Instrumentation
import android.content.*
import android.os.*
import android.webkit.CookieManager
import com.dshphone.browser.BrowserService
import org.json.JSONObject
import org.json.JSONTokener
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Headless checks in a disposable UID; no production DSH component is addressed. */
class BrowserRetentionInstrumentation : Instrumentation() {
    private lateinit var arguments: Bundle
    override fun onCreate(args: Bundle) { super.onCreate(args); arguments=args; start() }
    private fun <T> main(action:()->T):T {
        val result=CompletableFuture<T>()
        runOnMainSync { try { result.complete(action()) } catch(e:Throwable) { result.completeExceptionally(e) } }
        return result.get(20,TimeUnit.SECONDS)
    }
    private fun call(method:String,args:JSONObject=JSONObject()):JSONObject {
        val result=CompletableFuture<JSONObject>()
        main { try { BrowserService.current!!.call("retention_fixture",method,args) { value,error->
            if(error!=null)result.completeExceptionally(error) else result.complete(value!!)
        } } catch(e:Throwable) { result.completeExceptionally(e) } }
        return result.get(20,TimeUnit.SECONDS)
    }
    private fun evaluate(id:String,expression:String):JSONObject {
        val result=CompletableFuture<JSONObject>()
        main { BrowserService.current!!.view("retention_fixture",id)!!.evaluateJavascript(expression) { raw->
            try { result.complete(JSONObject(JSONTokener(raw).nextValue().toString())) } catch(e:Throwable) { result.completeExceptionally(e) }
        } }
        return result.get(10,TimeUnit.SECONDS)
    }
    override fun onStart() {
        val report=JSONObject();val phase=arguments.getString("phase")!!
        val expected=arguments.getString("expected")=="true"
        var connection:ServiceConnection?=null
        val server=ServerSocket(0,8,InetAddress.getByName("127.0.0.1"))
        val http=Thread({while(!server.isClosed)runCatching {
            server.accept().use { socket->
                socket.soTimeout=3000
                val input=socket.getInputStream().bufferedReader()
                while(!input.readLine().isNullOrEmpty()) {}
                val body="""<!doctype html><title>Browser retention fixture</title><input id="draft"><script>window.fixtureDocumentId=String(Math.random())</script>""".toByteArray()
                socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
                socket.getOutputStream().write(body);socket.getOutputStream().flush()
            }
        }},"browser-retention-http").apply { isDaemon=true;start() }
        try {
            check(targetContext.packageName.matches(Regex("com\\.dshphone\\.browserretentionverification\\.t[a-f0-9]{32}")))
            val bound=CompletableFuture<Unit>()
            connection=object:ServiceConnection {
                override fun onServiceConnected(name:ComponentName?,binder:IBinder?) { bound.complete(Unit) }
                override fun onServiceDisconnected(name:ComponentName?) {}
            }
            main { check(targetContext.bindService(Intent(targetContext,BrowserService::class.java),connection!!,Context.BIND_AUTO_CREATE)) }
            bound.get(15,TimeUnit.SECONDS)
            val origin="http://127.0.0.1:${server.localPort}/"
            if(phase=="before") {
                val stored=CompletableFuture<Boolean>()
                main { CookieManager.getInstance().setCookie(origin,"retention_fixture=preserved; Path=/; Max-Age=3600") { stored.complete(it) } }
                check(stored.get(10,TimeUnit.SECONDS));main { CookieManager.getInstance().flush() }
            }
            check(main { CookieManager.getInstance().getCookie(origin) ?: "" }.contains("retention_fixture=preserved"))
            val id=call("open",JSONObject().put("url",origin).put("viewportWidth",412).put("viewportHeight",915)).getString("active")
            val initial=evaluate(id,"JSON.stringify((()=>{document.querySelector('#draft').value='中文草稿';return{documentId:window.fixtureDocumentId,draft:document.querySelector('#draft').value}})())")
            val view=main { BrowserService.current!!.view("retention_fixture",id)!! }
            repeat(3) { call("profile",JSONObject().put("tabId",id).put("viewportWidth",412).put("viewportHeight",915).put("identity","android-real")) }
            val after=evaluate(id,"JSON.stringify({documentId:window.fixtureDocumentId,draft:document.querySelector('#draft').value})")
            val sameView=main { BrowserService.current!!.view("retention_fixture",id)===view }
            val preserved=after.getString("documentId")==initial.getString("documentId")&&after.getString("draft")=="中文草稿"
            check(sameView==expected&&preserved==expected) { "Unexpected preservation: sameView=$sameView, draft=$preserved, expected=$expected" }
            check(main { BrowserService.current!!.view("other_owner",id)==null })
            check(runCatching { call("profile",JSONObject().put("tabId",id).put("viewportWidth",239)) }.isFailure)
            val beforeReload=evaluate(id,"JSON.stringify({documentId:window.fixtureDocumentId})").getString("documentId")
            call("reload",JSONObject().put("tabId",id))
            val reloaded=evaluate(id,"JSON.stringify({documentId:window.fixtureDocumentId,draft:document.querySelector('#draft').value})")
            check(reloaded.getString("documentId")!=beforeReload&&reloaded.getString("draft").isEmpty())
            val beforeChange=main { BrowserService.current!!.view("retention_fixture",id)!! }
            call("profile",JSONObject().put("tabId",id).put("viewportWidth",820).put("viewportHeight",1180))
            check(main { BrowserService.current!!.view("retention_fixture",id)!==beforeChange })
            val old=main { BrowserService.current!!.view("retention_fixture",id)!! }
            // Simulate the renderer-exit callback without killing another renderer/process.
            main { check(old.webViewClient.onRenderProcessGone(old,null)) }
            call("profile",JSONObject().put("tabId",id).put("viewportWidth",820).put("viewportHeight",1180))
            check(evaluate(id,"JSON.stringify({loaded:!!document.querySelector('#draft')})").getBoolean("loaded"))
            check(main { CookieManager.getInstance().getCookie(origin) ?: "" }.contains("retention_fixture=preserved"))
            report.put("phase",phase).put("passed",true).put("expectedPreservation",expected).put("sameView",sameView)
                .put("documentAndChineseDraftPreserved",preserved).put("cookiePreserved",true).put("ownerBoundary",true)
                .put("invalidProfileRejected",true).put("explicitReloadStillReloads",true).put("changedProfileStillRebuilds",true)
                .put("simulatedRendererExitRecovery",true).put("productionPackageTouched",false)
            sendStatus(0,Bundle().apply { putString("stream","DSH_BROWSER_RETENTION_OK $report\n") })
            finish(Activity.RESULT_OK,Bundle().apply { putString("stream","Browser retention verified\n") })
        } catch(e:Throwable) {
            report.put("phase",phase).put("error",e.message?:e.javaClass.name)
            sendStatus(0,Bundle().apply { putString("stream","DSH_BROWSER_RETENTION_FAILED $report\n") })
            finish(Activity.RESULT_CANCELED,Bundle().apply { putString("stream",e.stackTraceToString()) })
        } finally {
            main { connection?.let { targetContext.unbindService(it) };targetContext.stopService(Intent(targetContext,BrowserService::class.java)) }
            server.close();http.join(1000)
        }
    }
}
