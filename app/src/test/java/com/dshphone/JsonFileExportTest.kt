package com.dshphone

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.net.Uri
import android.os.Looper
import android.webkit.ValueCallback
import android.webkit.WebView
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.io.File
import java.io.FileOutputStream
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executor

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
@LooperMode(LooperMode.Mode.PAUSED)
class JsonFileExportTest {
    class SaveActivity : Activity() {
        var rejectPicker = false
        override fun startActivityForResult(intent: Intent, requestCode: Int) {
            if (rejectPicker) throw android.content.ActivityNotFoundException()
            super.startActivityForResult(intent, requestCode)
        }
    }
    class Page(activity: Activity) : WebView(activity) {
        var pageUrl = "http://127.0.0.1:3080/"
        var answer = "null"
        var delayed: ValueCallback<String>? = null
        var delayPull = false
        val scripts = mutableListOf<String>()
        override fun getUrl() = pageUrl
        override fun evaluateJavascript(script: String, callback: ValueCallback<String>?) {
            scripts.add(script)
            if (callback != null) { if (delayPull) delayed = callback else callback.onReceiveValue(answer) }
        }
    }
    private lateinit var activity: SaveActivity
    private lateinit var page: Page
    private lateinit var exporter: JsonFileExport
    private val ticket = "0123456789abcdef0123456789abcdef"
    private val uri = Uri.parse("content://test.backup/document/export.json")
    private val text = "{\n  \"accounts\": [{\"id\": \"synthetic-test\"}],\n  \"label\": \"中文备份\"\n}"
    @Before fun setup() {
        activity = Robolectric.buildActivity(SaveActivity::class.java).setup().get()
        page = Page(activity)
        exporter = JsonFileExport(activity, Executor { it.run() })
        supply("dsh-codearts-backup-test.json", text)
    }
    private fun supply(name: String, value: String) { page.answer = JSONObject().put("filename", name).put("text", value).toString() }
    private fun result(code: Int = Activity.RESULT_OK, target: Uri = uri) {
        assertTrue(exporter.onActivityResult(JsonFileExport.REQUEST_CODE, code, Intent().setData(target)))
        shadowOf(Looper.getMainLooper()).idle()
    }
    private fun assertStatus(status: String) { assertTrue(page.scripts.last().contains("\"$status\"")) }
    @Test fun pickerSavesExactUtf8BytesBeforeAcknowledgingSuccess() {
        exporter.request(page, ticket)
        val picker = shadowOf(activity).nextStartedActivityForResult
        assertEquals(JsonFileExport.REQUEST_CODE, picker.requestCode)
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, picker.intent.action)
        assertEquals("application/json", picker.intent.type)
        assertEquals("dsh-codearts-backup-test.json", picker.intent.getStringExtra(Intent.EXTRA_TITLE))
        assertEquals("primary:Download", android.provider.DocumentsContract.getDocumentId(
            picker.intent.getParcelableExtra(android.provider.DocumentsContract.EXTRA_INITIAL_URI)!!))
        assertFalse(page.scripts.any { it.contains("\"saved\"") })
        val file = File.createTempFile("jethub-export", ".json", activity.cacheDir)
        shadowOf(activity.contentResolver).registerOutputStream(uri, FileOutputStream(file))
        result()
        assertArrayEquals(text.toByteArray(Charsets.UTF_8), file.readBytes())
        assertStatus("saved")
        file.delete()
    }
    @Test fun encryptedEnvelopeIsSavedWithoutChangingCiphertextOrFilename() {
        val encrypted = "{\"kind\":\"dsh-codearts-encrypted\",\"ciphertext\":\"synthetic-ciphertext\"}"
        supply("dsh-codearts-backup-test.enc.json", encrypted)
        page.pageUrl = "http://127.0.0.1:3081/settings"
        exporter.request(page, ticket)
        assertEquals("dsh-codearts-backup-test.enc.json", shadowOf(activity).nextStartedActivityForResult.intent.getStringExtra(Intent.EXTRA_TITLE))
        val file = File.createTempFile("jethub-encrypted", ".json", activity.cacheDir)
        shadowOf(activity.contentResolver).registerOutputStream(uri, FileOutputStream(file))
        result(); assertEquals(encrypted, file.readText()); assertStatus("saved"); file.delete()
    }
    @Test fun cancellingDoesNotWriteAndAllowsAnotherSave() {
        val stream = ByteArrayOutputStream(); shadowOf(activity.contentResolver).registerOutputStream(uri, stream)
        exporter.request(page, ticket); result(Activity.RESULT_CANCELED)
        assertStatus("cancelled"); assertEquals(0, stream.size())
        exporter.request(page, ticket); result(); assertStatus("saved")
        assertEquals(text, stream.toString("UTF-8"))
    }
    @Test fun streamCloseFailureReportsErrorAndASecondAttemptCanSucceed() {
        shadowOf(activity.contentResolver).registerOutputStream(uri, object : ByteArrayOutputStream() {
            override fun close() { throw java.io.IOException("synthetic provider failure") }
        })
        exporter.request(page, ticket); result(); assertStatus("error")
        assertFalse(page.scripts.any { it.contains("\"saved\"") })
        val stream = ByteArrayOutputStream(); shadowOf(activity.contentResolver).registerOutputStream(uri, stream)
        exporter.request(page, ticket); result(); assertStatus("saved"); assertEquals(text, stream.toString("UTF-8"))
    }
    @Test fun unavailablePickerAndInvalidDestinationDoNotReportSaved() {
        activity.rejectPicker = true; exporter.request(page, ticket); assertStatus("error")
        activity.rejectPicker = false; exporter.request(page, ticket); result(target = Uri.parse("file:///tmp/forbidden.json")); assertStatus("error")
        exporter.request(page, ticket); result(Activity.RESULT_CANCELED); assertStatus("cancelled")
    }
    @Test fun remotePagesInvalidPayloadsAndOversizeUtf8CannotOpenThePicker() {
        for (url in listOf("https://127.0.0.1:3080/", "http://evil.test:3080/", "http://user@127.0.0.1:3080/", "http://127.0.0.1:8326/")) {
            page.pageUrl = url; exporter.request(page, ticket)
            assertNull(shadowOf(activity).nextStartedActivityForResult)
        }
        page.pageUrl = "http://127.0.0.1:3080/"
        for ((name, value) in listOf("../backup.json" to text, "backup.json" to "not JSON", "backup.json" to JSONObject().put("text", "中".repeat(JsonFileExport.MAX_BYTES / 3)).toString())) {
            supply(name, value); exporter.request(page, ticket); assertStatus("error")
            assertNull(shadowOf(activity).nextStartedActivityForResult)
        }
        supply("backup.json", text); exporter.request(page, "bad-ticket")
        assertNull(shadowOf(activity).nextStartedActivityForResult)
    }
    @Test fun navigationBeforeReadingPayloadCannotExportAnotherPage() {
        page.delayPull = true; exporter.request(page, ticket)
        page.pageUrl = "https://provider.example/"; page.delayed!!.onReceiveValue(page.answer)
        assertNull(shadowOf(activity).nextStartedActivityForResult)
        assertEquals(1, page.scripts.size)
    }
    @Test fun duplicateRequestsDoNotReplaceThePendingBackup() {
        exporter.request(page, ticket); exporter.request(page, ticket)
        exporter.request(page, "11111111111111111111111111111111")
        assertStatus("error"); assertNotNull(shadowOf(activity).nextStartedActivityForResult)
        assertNull(shadowOf(activity).nextStartedActivityForResult)
        val stream = ByteArrayOutputStream(); shadowOf(activity.contentResolver).registerOutputStream(uri, stream)
        result(); assertStatus("saved"); assertEquals(text, stream.toString("UTF-8"))
    }
    @Test fun activityDestructionDoesNotWipeBytesOwnedByAnActiveWriter() {
        var queued: Runnable? = null
        exporter = JsonFileExport(activity, Executor { queued = it })
        val stream = ByteArrayOutputStream(); shadowOf(activity.contentResolver).registerOutputStream(uri, stream)
        exporter.request(page, ticket); result(); exporter.destroy(); queued!!.run(); shadowOf(Looper.getMainLooper()).idle()
        assertEquals(text, stream.toString("UTF-8")); assertFalse(page.scripts.any { it.contains("\"saved\"") })
    }
}
