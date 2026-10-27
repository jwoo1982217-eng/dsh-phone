package com.dshphone.incoming

import android.content.Context
import android.content.SharedPreferences

/** Only explicit user selection writes this setting; existing installations keep attach-current. */
internal class AndroidIncomingPreferences(context: Context) {
    private val stored = context.applicationContext.getSharedPreferences("incoming-handoff", Context.MODE_PRIVATE)
    private val preference = IncomingHandoffPreferences(AndroidIncomingPreferenceStore(stored))
    fun mode() = preference.mode()
    fun select(mode: IncomingHandoffMode) = preference.select(mode)
}

internal class AndroidIncomingPreferenceStore(private val stored: SharedPreferences) : IncomingHandoffPreferences.Store {
    @Synchronized override fun read() = stored.getString("mode", null)
    @Synchronized override fun write(value: String): Boolean {
        val previous = read()
        val saved = try { stored.edit().putString("mode", value).commit() } catch (_: RuntimeException) { false }
        if (!saved) {
            // Android updates the process map before reporting disk failure. Restore that choice too.
            try {
                val restore = stored.edit()
                if (previous == null) restore.remove("mode") else restore.putString("mode", previous)
                restore.commit()
            } catch (_: RuntimeException) { /* Caller still receives failure; never claim disk persistence. */ }
        }
        return saved
    }
}
