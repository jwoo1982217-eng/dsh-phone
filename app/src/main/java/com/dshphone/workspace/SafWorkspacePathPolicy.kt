package com.dshphone.workspace

/** SAF URI access is not POSIX access. Only an OS-listed, mounted local volume can be mapped. */
internal object SafWorkspacePathPolicy {
    const val EXTERNAL_STORAGE_AUTHORITY = "com.android.externalstorage.documents"
    data class Volume(val id: String, val root: String, val mounted: Boolean)
    data class Resolved(val path: String, val root: String)

    fun resolve(authority: String?, documentId: String, volumes: List<Volume>): Resolved? {
        if (authority != EXTERNAL_STORAGE_AUTHORITY || documentId.length > 4096) return null
        val colon = documentId.indexOf(':')
        if (colon <= 0) return null
        val id = documentId.substring(0, colon)
        val relative = documentId.substring(colon + 1)
        if (!id.matches(Regex("[A-Za-z0-9_-]{1,128}")) || !validRelative(relative)) return null
        val matches = volumes.filter { it.id.equals(id, ignoreCase = true) }
        val volume = matches.singleOrNull()?.takeIf { it.mounted } ?: return null
        val root = volume.root
        if (!root.startsWith("/") || root == "/" || !validRelative(root.drop(1))) return null
        return Resolved(if (relative.isEmpty()) root else "$root/$relative", root)
    }

    private fun validRelative(path: String): Boolean = path.isEmpty() ||
        !path.any { it == '\\' || it.code < 32 || it.code == 127 } &&
        path.split('/').none { it.isEmpty() || it == "." || it == ".." }
}
