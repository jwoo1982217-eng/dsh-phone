package com.dshphone.workspace

import java.io.File

internal object SafWorkspaceDirectoryAccess {
    /** No probe files: an unreadable/unmounted/protected directory must not become a raw workspace. */
    fun usable(selected: SafWorkspacePathPolicy.Resolved): Boolean = runCatching {
        val root = File(selected.root).canonicalFile
        val directory = File(selected.path).canonicalFile
        val inside = directory == root || directory.path.startsWith(root.path + File.separator)
        inside && directory.isDirectory && directory.canRead() && directory.canWrite()
    }.getOrDefault(false)
}
