package com.dshphone

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 开机自启：启动 dsh 前台服务（墨枢没有这一环，补上）。 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            context.startForegroundService(Intent(context, DshService::class.java))
        }
    }
}
