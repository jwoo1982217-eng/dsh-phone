package com.dshphone.terminal

/** Linux /proc identities include start-time ticks so a reused PID is never signalled. */
object ProcessTree {
    data class Identity(val pid: Int, val parentPid: Int, val started: String)
    fun parse(expectedPid: Int, stat: String): Identity? = runCatching {
        if (expectedPid <= 1 || stat.substringBefore(' ').toInt() != expectedPid) return null
        val close = stat.lastIndexOf(") ")
        if (close < 0) return null
        val fields = stat.substring(close+2).trim().split(Regex("\\s+"))
        val parent = fields[1].toInt()
        val started = fields[19]
        if (!started.all { it.isDigit() }) return null
        Identity(expectedPid, parent, started)
    }.getOrNull()
    fun descendants(root: Identity, processes: List<Identity>): List<Identity> {
        if (processes.none { it == root }) return emptyList()
        val children = processes.groupBy { it.parentPid }
        val seen = hashSetOf(root.pid)
        val result = mutableListOf<Identity>()
        fun visit(parent: Int, depth: Int) {
            if (depth >= 64) return
            for (child in children[parent].orEmpty()) if (seen.add(child.pid)) {
                visit(child.pid, depth+1); result.add(child)
            }
        }
        visit(root.pid, 0)
        return result
    }
}
