package com.dshphone

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class FilePickerTest {
    class PickerActivity : Activity() {
        var photoUnavailable = false
        var allUnavailable = false
        override fun startActivityForResult(intent: Intent, requestCode: Int) {
            if (allUnavailable || photoUnavailable && intent.action == MediaStore.ACTION_PICK_IMAGES)
                throw android.content.ActivityNotFoundException("fixture picker unavailable")
            super.startActivityForResult(intent, requestCode)
        }
    }
    class Page(activity: Activity) : WebView(activity) {
        var page = "http://127.0.0.1:3080/chat"
        override fun getUrl() = page
    }
    private lateinit var activity: Activity
    private lateinit var page: Page
    private lateinit var picker: FilePicker
    private val results = mutableListOf<Array<Uri>?>()
    private fun choose(types: Array<String>, multiple: Boolean = false) = picker.choose(page, ValueCallback { results.add(it) },
        object : WebChromeClient.FileChooserParams() {
            override fun getMode() = if (multiple) MODE_OPEN_MULTIPLE else MODE_OPEN
            override fun getAcceptTypes() = types
            override fun isCaptureEnabled() = false
            override fun getTitle(): CharSequence? = null
            override fun getFilenameHint(): String? = null
            override fun createIntent() = Intent(Intent.ACTION_GET_CONTENT)
        })
    @Before fun setup() {
        activity = Robolectric.buildActivity(PickerActivity::class.java).setup().get()
        page = Page(activity); picker = FilePicker(activity)
    }
    @Test fun imageOnlyUsesSystemPhotoPickerWithoutStoragePermission() {
        assertTrue(choose(arrayOf("image/png", "image/jpeg")))
        val intent = shadowOf(activity).nextStartedActivityForResult.intent
        assertEquals(MediaStore.ACTION_PICK_IMAGES, intent.action)
        assertEquals("image/*", intent.type)
        assertFalse(intent.hasExtra(MediaStore.EXTRA_PICK_IMAGES_MAX))
    }
    @Test fun multipleImagesAdvertiseBoundedPickerLimit() {
        choose(arrayOf(".jpg, .png"), true)
        val intent = shadowOf(activity).nextStartedActivityForResult.intent
        assertEquals(MediaStore.ACTION_PICK_IMAGES, intent.action)
        assertTrue(intent.getIntExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, 0) >= 2)
    }
    @Test @Config(sdk = [28]) fun oldAndroidUsesImageContentPicker() {
        choose(arrayOf("image/*"), true)
        val intent = shadowOf(activity).nextStartedActivityForResult.intent
        assertEquals(Intent.ACTION_GET_CONTENT, intent.action)
        assertEquals("image/*", intent.type)
        assertTrue(intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
    }
    @Test fun markdownUnknownEmptyAndMixedTypesKeepFullDocumentPicker() {
        for (types in listOf(emptyArray(), arrayOf(""), arrayOf(".md"), arrayOf("image/png", "application/pdf"))) {
            choose(types)
            val intent = shadowOf(activity).nextStartedActivityForResult.intent
            assertEquals(Intent.ACTION_OPEN_DOCUMENT, intent.action)
            assertEquals("*/*", intent.type)
            picker.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_CANCELED, null)
        }
    }
    @Test fun contentResultIsDeliveredOnceAndCancelAllowsRetry() {
        choose(arrayOf("image/*")); shadowOf(activity).nextStartedActivityForResult
        val uri = Uri.parse("content://photos/7")
        picker.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_OK, Intent().setData(uri))
        picker.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_OK, Intent().setData(uri))
        assertEquals(1, results.size); assertArrayEquals(arrayOf(uri), results.single())
        choose(emptyArray()); picker.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_CANCELED, null)
        assertNull(results.last()); choose(emptyArray()); assertNotNull(shadowOf(activity).nextStartedActivityForResult)
    }
    @Test fun overlappingRequestCannotStealFirstResult() {
        choose(emptyArray()); shadowOf(activity).nextStartedActivityForResult
        choose(arrayOf("image/*")); assertEquals(1, results.size); assertNull(results.single())
        assertNull(shadowOf(activity).nextStartedActivityForResult)
        picker.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_OK, Intent().setData(Uri.parse("content://docs/a")))
        assertEquals("content://docs/a", results.last()!!.single().toString())
    }
    @Test fun remoteAndCredentialBearingOriginsCannotOpenNativePicker() {
        for (url in listOf("https://127.0.0.1:3080/", "http://user@127.0.0.1:3080/", "https://example.org/", "http://127.0.0.1:8326/")) {
            page.page = url
            assertFalse(choose(arrayOf("image/*")))
            assertNull(shadowOf(activity).nextStartedActivityForResult)
        }
    }
    @Test fun navigationAndDestructionCancelWithoutDeliveringToAnotherPage() {
        choose(emptyArray()); page.page = "http://127.0.0.1:3080/settings"
        picker.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_OK, Intent().setData(Uri.parse("content://docs/a")))
        assertNull(results.single())
        choose(emptyArray()); picker.destroy(); picker.destroy()
        assertEquals(2, results.size); assertNull(results.last())
    }
    @Test fun fileSchemeIsNotAcceptedFromPicker() {
        choose(emptyArray())
        picker.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_OK, Intent().setData(Uri.parse("file:///data/private")))
        assertNull(results.single())
    }
    @Test fun unavailableModernPickerFallsBackToImagesAndTotalFailureAllowsRetry() {
        val host=activity as PickerActivity;host.photoUnavailable=true
        choose(arrayOf("image/*"))
        assertEquals(Intent.ACTION_GET_CONTENT,shadowOf(activity).nextStartedActivityForResult.intent.action)
        picker.onActivityResult(FilePicker.REQUEST_CODE,Activity.RESULT_CANCELED,null)
        host.allUnavailable=true;choose(emptyArray());assertNull(results.last())
        host.allUnavailable=false;choose(emptyArray())
        assertEquals(Intent.ACTION_OPEN_DOCUMENT,shadowOf(activity).nextStartedActivityForResult.intent.action)
    }
    @Test fun multipleResultsAreDeduplicatedAndSingleInputRemainsSingle() {
        val uri=Uri.parse("content://photos/a");val other=Uri.parse("content://photos/b")
        fun data() = Intent().apply {clipData=android.content.ClipData.newRawUri("photo",uri).apply {
            addItem(android.content.ClipData.Item(uri));addItem(android.content.ClipData.Item(other))
        }}
        choose(arrayOf("image/*"),true);picker.onActivityResult(FilePicker.REQUEST_CODE,Activity.RESULT_OK,data())
        assertArrayEquals(arrayOf(uri,other),results.last())
        choose(arrayOf("image/*"));picker.onActivityResult(FilePicker.REQUEST_CODE,Activity.RESULT_OK,data())
        assertArrayEquals(arrayOf(uri),results.last())
    }

}
