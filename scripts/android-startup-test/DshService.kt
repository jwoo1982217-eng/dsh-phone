package com.dshphone

/** Test sink for the production NodeRunner; no foreground service is started. */
object DshService {
    var browserLaunchUrl: String? = null
    private val logs = mutableListOf<String>()
    fun appendLog(line: String) = synchronized(logs) { logs.add(line); Unit }
    fun snapshotLogs(): List<String> = synchronized(logs) { logs.toList() }
}
