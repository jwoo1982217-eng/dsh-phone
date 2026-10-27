package com.dshphone.workspace

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.net.Uri
import android.os.Looper
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.time.Duration

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
@LooperMode(LooperMode.Mode.PAUSED)
class SafWorkspacePickerTest {
    class PickerActivity : Activity() {
        var unavailable = false
        override fun startActivityForResult(intent: Intent, requestCode: Int) {
            if (unavailable) throw android.content.ActivityNotFoundException("fixture picker unavailable")
            super.startActivityForResult(intent, requestCode)
        }
    }
    private lateinit var activity: PickerActivity
    private lateinit var picker: SafWorkspacePicker
    private val results = mutableListOf<SafWorkspacePicker.Result>()
    private val persisted = mutableListOf<Pair<Uri, Int>>()
    private var access = true
    private var usable = true
    private var persistence = true
    private var storageFailure = false
    private val local = Uri.parse("content://com.android.externalstorage.documents/tree/primary%3ADocuments%2F%E9%A1%B9%E7%9B%AE%20%E7%A9%BA%E6%A0%BC")
    private val rw = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    @Before fun setup() {
        activity = Robolectric.buildActivity(PickerActivity::class.java).setup().get()
        picker = SafWorkspacePicker(activity, { results.add(it) }, 1000L,
            accessGranted = { access },
            volumeProvider = {
                if (storageFailure) throw SecurityException("fixture storage failure")
                listOf(SafWorkspacePathPolicy.Volume("primary", "/storage/emulated/10", true))
            }, directoryUsable = { usable }, persistGrant = { uri, flags ->
                persisted.add(uri to flags); persistence
            })
    }
    private fun request(id: String = "request"): Int {
        assertTrue(picker.request(id))
        val next = shadowOf(activity).nextStartedActivityForResult
        assertNotNull("ACTION_OPEN_DOCUMENT_TREE must launch", next)
        assertEquals(Intent.ACTION_OPEN_DOCUMENT_TREE, next.intent.action)
        assertEquals(rw, next.intent.flags and rw)
        assertTrue(next.intent.flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION != 0)
        return next.requestCode
    }
    private fun selected(code: Int, uri: Uri = local, flags: Int = rw or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) {
        assertTrue(picker.onActivityResult(code, Activity.RESULT_OK, Intent().setData(uri).addFlags(flags)))
    }
    @Test @Config(sdk = [28]) fun defaultAdapterUsesExistingStorageAccessAndNeverRequestsNewPermission() {
        org.robolectric.Shadows.shadowOf(org.robolectric.RuntimeEnvironment.getApplication())
            .denyPermissions(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
        val actual = SafWorkspacePicker(activity, { results.add(it) })
        assertFalse(actual.request("actual-default"))
        assertEquals(SafWorkspacePicker.Status.PERMISSION_REQUIRED, results.single().status)
        assertNull(shadowOf(activity).nextStartedActivityForResult)
        assertNull(shadowOf(activity).lastRequestedPermission)
    }
    @Test fun selectedDirectoryPersistsExactGrantAndDeliversPhysicalPathOnce() {
        val code = request(); selected(code); selected(code)
        assertEquals(1, results.size)
        assertEquals(SafWorkspacePicker.Status.SELECTED, results.single().status)
        assertEquals("/storage/emulated/10/Documents/项目 空格", results.single().path)
        assertEquals(local.toString(), results.single().uri)
        assertTrue(results.single().persistedGrant)
        assertEquals(listOf(local to rw), persisted)
    }
    @Test fun missingRawPermissionDoesNotLaunchSettingsPickerOrPersistUri() {
        access = false
        assertFalse(picker.request("no-permission"))
        assertEquals(SafWorkspacePicker.Status.PERMISSION_REQUIRED, results.single().status)
        assertNull(shadowOf(activity).nextStartedActivityForResult)
        assertTrue(persisted.isEmpty())
        access = true; request("retry")
    }
    @Test fun revokedRawPermissionWhilePickerOpenCannotPublishSelectedWorkspace() {
        val code = request(); access = false; selected(code)
        assertEquals(SafWorkspacePicker.Status.PERMISSION_REQUIRED, results.single().status)
        assertTrue(persisted.isEmpty())
    }
    @Test fun overlappingRequestsDoNotReplaceOriginalAndCancelPermitsRetry() {
        val code = request("first")
        assertFalse(picker.request("second"))
        assertEquals(SafWorkspacePicker.Status.BUSY, results.single().status)
        assertEquals("second", results.single().requestId)
        assertTrue(picker.onActivityResult(code, Activity.RESULT_CANCELED, null))
        assertEquals("first", results.last().requestId)
        assertEquals(SafWorkspacePicker.Status.CANCELLED, results.last().status)
        request("third")
    }
    @Test fun cloudAndNonTreeUrisCannotBecomeRawWorkspacePathsOrPermanentGrants() {
        for (uri in listOf(Uri.parse("content://cloud.documents/tree/primary%3ADocs"),
            Uri.parse("file:///storage/emulated/10/Documents"),
            Uri.parse("content://com.android.externalstorage.documents/document/primary%3ADocs"),
            Uri.parse("content://com.android.externalstorage.documents/tree/primary%3A..%2Foutside"))) {
            selected(request(), uri)
            assertEquals(SafWorkspacePicker.Status.UNSUPPORTED, results.last().status)
            assertNull(results.last().path)
        }
        assertTrue(persisted.isEmpty())
    }
    @Test fun incompleteOrUnpersistableGrantIsVisibleFailureNotTemporaryWorkspace() {
        selected(request(), flags = Intent.FLAG_GRANT_READ_URI_PERMISSION)
        assertEquals(SafWorkspacePicker.Status.ERROR, results.last().status)
        assertTrue(persisted.isEmpty())
        persistence = false; selected(request("retry"))
        assertEquals(SafWorkspacePicker.Status.ERROR, results.last().status)
        assertFalse(results.last().persistedGrant)
        persistence = true; selected(request("recovery"))
        assertEquals(SafWorkspacePicker.Status.SELECTED, results.last().status)
    }
    @Test fun unreadableDirectoryAndVolumeQueryFailureAreVisibleAndRetryable() {
        usable = false; selected(request())
        assertEquals(SafWorkspacePicker.Status.ERROR, results.last().status)
        usable = true; storageFailure = true; selected(request("storage-fail"))
        assertEquals(SafWorkspacePicker.Status.ERROR, results.last().status)
        storageFailure = false; selected(request("recovery"))
        assertEquals(SafWorkspacePicker.Status.SELECTED, results.last().status)
    }
    @Test fun timeoutAndLateResultCannotStealNewRequest() {
        val old = request("old")
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1001))
        assertEquals(SafWorkspacePicker.Status.TIMEOUT, results.single().status)
        val current = request("new")
        selected(old); assertEquals(1, results.size)
        selected(current); assertEquals("new", results.last().requestId)
        assertEquals(SafWorkspacePicker.Status.SELECTED, results.last().status)
    }
    @Test fun recreatedPickerDoesNotReuseEarlierActivityResultCode() {
        val old = request("old-instance"); picker.close()
        val replacement = SafWorkspacePicker(activity, { results.add(it) }, accessGranted = { true })
        assertTrue(replacement.request("new-instance"))
        val current = shadowOf(activity).nextStartedActivityForResult.requestCode
        assertNotEquals("late previous-Activity result must not own a new request", old, current)
        assertTrue(replacement.onActivityResult(old, Activity.RESULT_CANCELED, null))
        assertEquals(1, results.size)
        replacement.close()
        assertEquals("new-instance", results.last().requestId)
    }
    @Test fun duplicatePollingOfSameRequestIsIdempotentRatherThanCompletingBusy() {
        val code = request("same-engine-request")
        assertTrue(picker.request("same-engine-request"))
        assertTrue(results.isEmpty())
        assertNull(shadowOf(activity).nextStartedActivityForResult)
        selected(code)
        assertEquals(1, results.size)
        assertEquals(SafWorkspacePicker.Status.SELECTED, results.single().status)
    }
    @Test fun closeCancelsExactlyOnceAndRejectsFurtherLaunches() {
        val old = request(); picker.close(); picker.close(); selected(old)
        assertEquals(1, results.size); assertEquals(SafWorkspacePicker.Status.CLOSED, results.single().status)
        assertFalse(picker.request("after-close"))
        assertEquals(SafWorkspacePicker.Status.CLOSED, results.last().status)
        assertNull(shadowOf(activity).nextStartedActivityForResult)
    }
    @Test fun explicitCancelAndSystemActivityFailureBothReleaseSingleSlot() {
        val old = request(); picker.cancel(); selected(old)
        assertEquals(1, results.size); assertEquals(SafWorkspacePicker.Status.CANCELLED, results.single().status)
        activity.unavailable = true; assertFalse(picker.request("unavailable"))
        assertEquals(SafWorkspacePicker.Status.ERROR, results.last().status)
        activity.unavailable = false; request("recovery")
    }
    @Test fun invalidRequestIdAndUnrelatedActivityResultsDoNotOccupyPicker() {
        assertFalse(picker.request("")); assertFalse(picker.request("bad\nrequest"))
        assertEquals(2, results.size); assertEquals(SafWorkspacePicker.Status.ERROR, results.last().status)
        assertFalse(picker.onActivityResult(2401, Activity.RESULT_OK, Intent()))
        request("valid")
    }
}
