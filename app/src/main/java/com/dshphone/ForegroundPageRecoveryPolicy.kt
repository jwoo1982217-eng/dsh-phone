package com.dshphone

/** Adapted from kelai141/dsh-mobile-apk c8a5333 (MIT). Activity page recovery only; engine task/service watchdogs do not use this policy. */
internal class ForegroundPageRecoveryPolicy {
  enum class Recovery { NONE, RELOAD, RECREATE, NATIVE_ERROR }

  @Volatile var foreground = false
    private set
  @Volatile var generation = 0L
    private set
  @Volatile var rendererGone = false
    private set
  private var pending = Recovery.NONE
  private var loadErrorRetryUsed = false
  var rendererRecreationAttempted = false
    private set

  fun restoreRecreationBudget(alreadyAttempted: Boolean) {
    rendererRecreationAttempted = alreadyAttempted
  }

  fun resume() {
    generation++
    foreground = true
  }

  fun pause() {
    foreground = false
    generation++
  }

  fun accepts(expectedGeneration: Long): Boolean = foreground && !rendererGone && generation == expectedGeneration

  /** A failed engine navigation gets one automatic retry until the page actually reports ready. */
  fun claimLoadErrorRetry(): Boolean {
    if (!foreground || rendererGone || loadErrorRetryUsed) return false
    loadErrorRetryUsed = true
    return true
  }

  fun pageReady() {
    if (!rendererGone) {
      if (pending == Recovery.RELOAD) pending = Recovery.NONE
      loadErrorRetryUsed = false
      rendererRecreationAttempted = false
    }
  }

  fun userReloadRequested() {
    if (rendererGone) {
      pending = Recovery.RECREATE // Explicit native retry may recover after the automatic budget is spent.
    } else {
      loadErrorRetryUsed = false
      requestReload()
    }
  }

  /** Replace only the UI renderer, keeping this Activity, pending files and engine intact. */
  fun rendererReplaced() { rendererGone = false }

  fun requestReload() {
    if (pending != Recovery.RECREATE && !rendererGone) pending = Recovery.RELOAD
  }

  fun rendererLost() {
    if (rendererGone) return
    rendererGone = true
    generation++
    pending = if (rendererRecreationAttempted) Recovery.NATIVE_ERROR else Recovery.RECREATE
    rendererRecreationAttempted = true
  }

  /** Multiple background failures coalesce; renderer recreation supersedes a stale reload. */
  fun takeRecovery(): Recovery {
    if (!foreground) return Recovery.NONE
    return pending.also { pending = Recovery.NONE }
  }
}
