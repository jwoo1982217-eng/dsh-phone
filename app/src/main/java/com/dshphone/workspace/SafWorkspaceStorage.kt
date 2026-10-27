package com.dshphone.workspace

import android.app.Activity
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.storage.StorageManager

/** Uses the system's volume inventory; no guessed removable-volume paths or provider copying. */
internal object SafWorkspaceStorage {
    @Suppress("DEPRECATION")
    fun mountedVolumes(activity: Activity): List<SafWorkspacePathPolicy.Volume> {
        val manager = activity.getSystemService(StorageManager::class.java) ?: return emptyList()
        val legacy = if (Build.VERSION.SDK_INT < 30) {
            val suffix = "/Android/data/${activity.packageName}/files"
            activity.getExternalFilesDirs(null).filterNotNull().mapNotNull { directory ->
                val volume = manager.getStorageVolume(directory) ?: return@mapNotNull null
                val id = if (volume.isPrimary) "primary" else volume.uuid ?: return@mapNotNull null
                val path = directory.absolutePath
                if (!path.endsWith(suffix)) null else id to path.removeSuffix(suffix)
            }.toMap()
        } else emptyMap()
        return manager.storageVolumes.mapNotNull { volume ->
            val id = if (volume.isPrimary) "primary" else volume.uuid ?: return@mapNotNull null
            val root = if (Build.VERSION.SDK_INT >= 30) volume.directory?.absolutePath
                else legacy[id] ?: if (volume.isPrimary) Environment.getExternalStorageDirectory().absolutePath else null
            root?.let { SafWorkspacePathPolicy.Volume(id, it, volume.state == Environment.MEDIA_MOUNTED) }
        }
    }

    fun persistGrant(activity: Activity, uri: Uri, flags: Int): Boolean = runCatching {
        val resolver = activity.contentResolver
        resolver.takePersistableUriPermission(uri, flags)
        resolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission && it.isWritePermission }
    }.getOrDefault(false)
}
