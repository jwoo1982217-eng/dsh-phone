package com.dshphone

import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption

/** OFM has its own updater. An APK must not downgrade its newer installation. */
internal object BundledPackageUpgrade {
    private const val INDEPENDENT = "dsh-our-free-model"
    private val releaseVersion = Regex("(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)")

    private fun version(directory: File): List<Long> {
        check(directory.isDirectory && !Files.isSymbolicLink(directory.toPath())) {
            "Cannot replace an independently managed plugin through a link"
        }
        val file = File(directory, "package.json")
        check(file.isFile && !Files.isSymbolicLink(file.toPath())) { "Independent plugin manifest is not a regular file" }
        val data = JSONObject(file.readText())
        check(data.getString("name") == INDEPENDENT) { "Independent plugin identity changed; original runtime retained" }
        val match = releaseVersion.matchEntire(data.getString("version"))
        check(match != null) { "Unknown independent plugin version; original runtime retained" }
        return match.groupValues.drop(1).map { part ->
            part.toLongOrNull() ?: error("Independent plugin version is out of range")
        }
    }

    /** Resolve before moving the program tree, so invalid metadata leaves it intact. */
    fun preservedPackages(bundledModules: File, installedModules: File): Set<String> {
        val bundled = File(bundledModules, INDEPENDENT)
        val installed = File(installedModules, INDEPENDENT)
        if (!bundled.exists() || !Files.exists(installed.toPath(), LinkOption.NOFOLLOW_LINKS)) return emptySet()
        val next = version(bundled)
        val current = version(installed)
        for (index in current.indices) {
            if (current[index] > next[index]) return setOf(INDEPENDENT)
            if (current[index] < next[index]) return emptySet()
        }
        return emptySet()
    }
}
