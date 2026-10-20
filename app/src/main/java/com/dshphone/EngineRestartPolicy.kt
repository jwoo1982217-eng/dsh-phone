package com.dshphone

/** Bounded dead-process recovery; HTTP slowness never feeds this policy. Inspired by upstream WatchdogV2 (MIT). */
internal class EngineRestartPolicy {
    private var failures = 0
    private var startedAt: Long? = null
    val paused: Boolean @Synchronized get() = failures >= 12
    @Synchronized fun failed(): Long? {
        startedAt = null
        if (failures < 12) failures++
        return if (paused) null else 5_000L shl minOf(failures - 1, 4)
    }
    @Synchronized fun started(now: Long) { startedAt = now }
    @Synchronized fun alive(now: Long) {
        val start = startedAt ?: return
        if (now - start >= 120_000L) { failures = 0; startedAt = null }
    }
    @Synchronized fun userRetry() { failures = 0; startedAt = null }
}
