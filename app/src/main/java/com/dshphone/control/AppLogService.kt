package com.dshphone.control

import android.content.Context
import android.os.Binder
import android.os.Parcel

/** Shizuku UserService. Exposes one bounded, UID-filtered reader, never an arbitrary shell. */
class AppLogService(context: Context) : Binder() {
    private val clientUid = context.applicationInfo.uid
    init { attachInterface(null, DESCRIPTOR) }
    override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        if (code == INTERFACE_TRANSACTION) { reply?.writeString(DESCRIPTOR); return true }
        if (code == 16777115) { kotlin.system.exitProcess(0) }
        if (code != READ) return super.onTransact(code, data, reply, flags)
        check(getCallingUid() == clientUid) { "日志服务仅供自己的 DSH App 调用" }
        data.enforceInterface(DESCRIPTOR)
        val uid = data.readInt(); val lines = data.readInt()
        require(data.dataAvail() == 0) { "日志请求字段无效" }
        val text = AppLogReader.read(uid, lines)
        reply!!.writeNoException(); reply.writeString(text)
        return true
    }
    companion object { const val DESCRIPTOR = "com.dshphone.control.AppLogService"; const val READ = FIRST_CALL_TRANSACTION }
}
