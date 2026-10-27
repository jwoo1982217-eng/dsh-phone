package com.dshphone

import android.app.Application
import com.sun.net.httpserver.HttpServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.net.InetSocketAddress

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk=[35],application=Application::class)
class PeerLocalClientTest {
    @Test fun coldBootstrapAndHotCookieUseAuthenticatedLoopbackRpcWithoutCapabilityQuery() {
        // OpenJDK suppresses restricted headers if another suite initialized it first. Android does not.
        System.setProperty("sun.net.http.allowRestrictedHeaders","true")
        val server=HttpServer.create(InetSocketAddress("127.0.0.1",0),0)
        val origin="http://127.0.0.1:${server.address.port}"
        val origins=mutableListOf<String?>()
        val bodies=mutableListOf<JSONObject>();val queries=mutableListOf<String?>();var bootstraps=0;var denied=0
        server.createContext("/phone-peer/manage") { e ->
            queries.add(e.requestURI.rawQuery)
            val body=JSONObject(e.requestBody.bufferedReader().readText())
            origins.add(e.requestHeaders.getFirst("Origin"))
            if(e.requestHeaders.getFirst("Cookie")!="native=fixture") {denied++;e.sendResponseHeaders(401,-1)}
            else {
                bodies.add(body)
                val bytes="""{"result":{"ok":true,"value":{"paired":true,"connected":true}}}""".toByteArray()
                e.sendResponseHeaders(200,bytes.size.toLong());e.responseBody.use{it.write(bytes)}
            };e.close()
        }
        server.createContext("/") { e -> bootstraps++;e.responseHeaders.add("Set-Cookie","native=fixture; HttpOnly; Path=/");e.sendResponseHeaders(303,-1);e.close() }
        server.start()
        try {
            val cold=PeerLocalClient(origin,{"$origin/?token=synthetic-local-only"},{""})
            assertEquals(PeerStatus(true,true),cold.manage("pair","private-fixture-capability"))
            val hot=PeerLocalClient(origin,{error("unexpected bootstrap")},{"native=fixture"})
            assertEquals(PeerStatus(true,true),hot.manage("reconnect",null))
            assertEquals(1,bootstraps);assertEquals(1,denied);assertTrue(queries.all{it==null});assertTrue(origins.all{it==null || it==origin})
            assertEquals("client-request",bodies[0].getString("type"));assertEquals("manage",bodies[0].getString("method"))
            assertEquals("private-fixture-capability",bodies[0].getJSONObject("payload").getString("code"))
            assertFalse(bodies[1].getJSONObject("payload").has("code"))
        } finally {server.stop(0)}
    }
}
