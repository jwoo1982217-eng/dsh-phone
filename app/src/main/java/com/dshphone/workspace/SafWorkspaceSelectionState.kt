package com.dshphone.workspace

/** One system activity owns each lease; retired request codes must never select a newer workspace. */
internal class SafWorkspaceSelectionState(private val allocator: (() -> Int)? = null) {
    companion object { const val CODE_START = 28000; const val CODE_LIMIT = 28999 }
    data class Lease(val requestId: String, val code: Int)
    var current: Lease? = null
        private set
    private var nextCode = CODE_START

    fun begin(requestId: String): Lease? {
        if (current != null) return null
        val code = allocator?.invoke() ?: nextCode++
        if (code !in CODE_START..CODE_LIMIT) return null
        return Lease(requestId, code).also { current = it }
    }
    fun finish(code: Int): Lease? = if (current?.code == code) clear() else null
    fun clear(): Lease? = current.also { current = null }
}
