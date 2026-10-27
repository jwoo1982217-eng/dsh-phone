package com.dshphone.virtualscreen

import android.content.Context
import android.os.Binder
import android.os.Parcel
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

/** A same-app Binder with only fixed, nonzero-display actions, not a general shell endpoint. */
class VirtualDisplayService(context: Context) : Binder() {
    private val clientUid = context.applicationInfo.uid
    init { attachInterface(null, DESCRIPTOR) }
    override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        if (code == INTERFACE_TRANSACTION) { reply?.writeString(DESCRIPTOR); return true }
        if (code == 16777115) {
            check(getCallingUid() in setOf(clientUid, android.os.Process.myUid(), 0))
            kotlin.system.exitProcess(0)
        }
        if (code != ACTION) return super.onTransact(code, data, reply, flags)
        check(getCallingUid() == clientUid) { "虚拟屏服务仅供自己的 DSH App 调用" }
        data.enforceInterface(DESCRIPTOR)
        val raw = data.readString().orEmpty(); require(raw.length <= 16_384 && data.dataAvail() == 0)
        val args = JSONObject(raw); val id = args.getInt("displayId")
        VirtualScreenPolicy.requireOwned(args.getString("screenId"), id)
        val w = args.optInt("width"); val h = args.optInt("height")
        require(w in 240..1920 && h in 240..1920)
        val argv = when (args.getString("action")) {
            "tap" -> VirtualScreenPolicy.tap(id,w,h,args.getDouble("x"),args.getDouble("y"))
            "swipe" -> VirtualScreenPolicy.swipe(id,w,h,args.getDouble("x"),args.getDouble("y"),args.getDouble("endX"),args.getDouble("endY"),args.optInt("duration",300))
            "back" -> VirtualScreenPolicy.back(id)
            "launch" -> {
                val pkg = args.getString("package"); val user = clientUid / 100_000
                val resolved = run(VirtualScreenPolicy.resolveActivity(user,pkg))
                val component = resolved.lineSequence().map { it.trim() }
                    .firstOrNull { it.startsWith("$pkg/") && it.matches(Regex("[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+")) }
                    ?: error("所选 App 没有可打开的启动入口")
                VirtualScreenPolicy.launch(id,user,pkg,component)
            }
            else -> error("不支持的虚拟屏动作")
        }
        val output = run(argv)
        val value = JSONObject().put("status","completed").put("screenId","virtual-1").put("displayId",id).put("output",output.take(4096))
        if (args.getString("action") == "launch") {
            // A successful am exit is not proof that a ROM accepted the requested display.
            val proof = run(arrayOf("/system/bin/sh","-c","dumpsys activity activities | grep -E '^ *Display #|ActivityRecord'"))
            var target = -1; var found = false; val pkg = args.getString("package")
            for (line in proof.lineSequence()) {
                Regex("^\\s*Display #(\\d+)").find(line)?.let { target = it.groupValues[1].toInt() }
                if (target == id && line.contains("ActivityRecord") && line.contains(" $pkg/")) found = true
            }
            check(found) { "系统未确认 App 落在虚拟屏；不会改在真实屏打开。请检查该 ROM 的跨屏支持" }
            value.put("launchDisplayVerified",true)
        }
        reply!!.writeNoException(); reply.writeString(value.toString()); return true
    }
    private fun run(argv: Array<String>): String {
        val process = ProcessBuilder(*argv).redirectErrorStream(true).start()
        val output = ByteArrayOutputStream(); var overflow = false
        val readError = java.util.concurrent.atomic.AtomicReference<Throwable?>()
        val reader = Thread {
          try { process.inputStream.use { input ->
                val bytes = ByteArray(4096)
                while (true) {
                    val count = input.read(bytes); if (count < 0) break
                    synchronized(output) {
                        if (output.size() + count <= 65_536) output.write(bytes,0,count) else overflow = true
                    }
                }
            } } catch (error: Throwable) { readError.set(error) }
        }.apply { isDaemon = true; start() }
        try {
            check(process.waitFor(6,TimeUnit.SECONDS)) { "虚拟屏命令超时；结果未知，请先查看屏幕，不要自动重试" }
            reader.join(1000); check(!reader.isAlive && !overflow && readError.get() == null) { "虚拟屏回执过长或不完整" }
            val text = synchronized(output) { output.toString("UTF-8") }
            check(process.exitValue() == 0) { "虚拟屏操作失败：${text.take(1200)}" }; return text
        } finally {
            if (process.isAlive) process.destroyForcibly()
            runCatching { process.inputStream.close() }
        }
    }
    companion object { const val DESCRIPTOR = "com.dshphone.virtualscreen.VirtualDisplayService"; const val ACTION = FIRST_CALL_TRANSACTION }
}
