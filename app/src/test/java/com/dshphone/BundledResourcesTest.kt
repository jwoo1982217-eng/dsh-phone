package com.dshphone

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.security.MessageDigest

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class BundledResourcesTest {
    @get:Rule val temp = TemporaryFolder()

    private fun manifest(template: File, content: ByteArray, target: String = "profiles/phone/node_modules/example/model.bin", sha: String? = null) {
        val hash = sha ?: MessageDigest.getInstance("SHA-256").digest(content).joinToString("") { "%02x".format(it.toInt() and 255) }
        val row = JSONObject().put("source", "node_modules/example/model.bin").put("target", target).put("bytes", content.size).put("sha256", hash)
        File(template, ".shared-runtime-files.json").writeText(JSONObject().put("version", 1).put("files", JSONArray().put(row)).toString())
    }

    @Test fun restoresExactModuleBytesAndKeepsSource() {
        val tree = temp.newFolder("tree"); val template = temp.newFolder("template")
        val content = ByteArray(140000) { (it % 251).toByte() }
        val source = File(tree, "node_modules/example/model.bin"); source.parentFile!!.mkdirs(); source.writeBytes(content)
        manifest(template, content)
        assertEquals(1, BundledResources.hydrate(tree, template))
        assertArrayEquals(content, File(template, "profiles/phone/node_modules/example/model.bin").readBytes())
        assertArrayEquals(content, source.readBytes())
        assertFalse(File(template, ".shared-runtime-files.json").exists())
    }

    @Test fun corruptionStopsBeforeOldRuntimeIsReplacedAndCanRetry() {
        val tree = temp.newFolder("tree"); val template = temp.newFolder("template"); val old = temp.newFile("old-runtime")
        old.writeText("keep old version")
        val source = File(tree, "node_modules/example/model.bin"); source.parentFile!!.mkdirs(); source.writeText("actual")
        manifest(template, source.readBytes(), sha = "0".repeat(64))
        assertThrows(IllegalStateException::class.java) { BundledResources.hydrate(tree, template) }
        assertFalse(File(template, "profiles/phone/node_modules/example/model.bin").exists())
        assertFalse(File(template, "profiles/phone/node_modules/example/model.bin.hydrate-stage").exists())
        assertEquals("keep old version", old.readText())
        manifest(template, source.readBytes())
        assertEquals(1, BundledResources.hydrate(tree, template))
    }

    @Test fun rejectsEscapedPathsAndAcceptsLegacyNonDeduplicatedAssets() {
        val tree = temp.newFolder("tree"); val template = temp.newFolder("template")
        assertEquals(0, BundledResources.hydrate(tree, template))
        val source = File(tree, "node_modules/example/model.bin"); source.parentFile!!.mkdirs(); source.writeText("actual")
        manifest(template, source.readBytes(), target = "profiles/phone/node_modules/../../../../escaped")
        assertThrows(IllegalStateException::class.java) { BundledResources.hydrate(tree, template) }
        assertFalse(File(temp.root, "escaped").exists())
    }
}
