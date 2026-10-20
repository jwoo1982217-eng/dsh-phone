package com.dshphone.control

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Non-exported; only the one-shot capability handed to Termux delivers a result. */
class TermuxResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val uri = intent.data ?: return
        if (uri.scheme != "dsh-termux-result" || uri.host != "job") return
        val id = uri.lastPathSegment ?: return
        TermuxCommands.receive(id, intent.getBundleExtra(TermuxCommands.RESULT_BUNDLE))
    }
}
