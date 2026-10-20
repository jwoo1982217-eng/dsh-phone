package com.dshphone

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.util.UUID

/** Read-only probe of the local Agent; no model request and no secret persisted or logged. */
object LocalSessionStatus {
    fun activeCount(existingCookie: String): Int? {
        if (!NodeRunner.portOpen(NodeRunner.WEB_PORT)) return null
        var cookie = existingCookie
        fun query(): Int? {
            val connection = URL("http://127.0.0.1:3080/api/session/list").openConnection(Proxy.NO_PROXY) as HttpURLConnection
            return try {
                connection.requestMethod = "POST"; connection.doOutput = true
                connection.connectTimeout = 1500; connection.readTimeout = 3000
                connection.setRequestProperty("Cookie", cookie)
                connection.setRequestProperty("Content-Type", "application/json")
                val body = JSONObject().put("type", "client-request").put("rpcId", UUID.randomUUID().toString())
                    .put("method", "session/list").put("payload", JSONObject().put("args", JSONObject().put("_request", JSONObject())))
                connection.outputStream.use { it.write(body.toString().toByteArray()) }
                if (connection.responseCode != 200) return null
                val result = JSONObject(connection.inputStream.bufferedReader().use { it.readText() }).getJSONObject("result")
                if (!result.getBoolean("ok")) return null
                val rows = result.getJSONObject("value").getJSONArray("items")
                (0 until rows.length()).count { rows.getJSONObject(it).optBoolean("running") }
            } catch (_: Exception) { null } finally { connection.disconnect() }
        }
        query()?.let { return it }
        // A fresh native recovery window may open before the WebView has received its cookie.
        val launch = DshService.browserLaunchUrl ?: return null
        val bootstrap = URL(launch).openConnection(Proxy.NO_PROXY) as HttpURLConnection
        try {
            bootstrap.connectTimeout = 1500; bootstrap.readTimeout = 3000; bootstrap.instanceFollowRedirects = false
            if (bootstrap.responseCode != 303) return null
            cookie = bootstrap.headerFields.filterKeys { it?.equals("Set-Cookie", ignoreCase = true) == true }
                .values.flatten().joinToString("; ") { it.substringBefore(';') }
        } catch (_: Exception) { return null } finally { bootstrap.disconnect() }
        return query()
    }
}
