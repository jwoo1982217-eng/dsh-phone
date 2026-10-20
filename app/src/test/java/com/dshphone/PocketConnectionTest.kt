package com.dshphone

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.Manifest
import android.content.pm.PackageManager
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.CaptureActivity
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
@LooperMode(LooperMode.Mode.PAUSED)
class PocketConnectionTest {
    private lateinit var activity: Activity
    private lateinit var connection: PocketConnection
    private val opened = mutableListOf<String>()

    @Before fun setup() {
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        activity.getSharedPreferences("pocket-connection", Activity.MODE_PRIVATE).edit().clear().commit()
        connection = PocketConnection(activity, { opened.add(it) }, {})
    }

    @Test fun cameraScanOpensAppCallbackAndNextOpenUsesSavedAddress() {
        connection.scan()
        val scan = shadowOf(activity).nextStartedActivityForResult
        assertEquals(PocketConnection.REQUEST_CODE, scan.requestCode)
        assertEquals("com.journeyapps.barcodescanner.CaptureActivity", scan.intent.component?.className)
        assertEquals("QR_CODE", scan.intent.getStringExtra(Intents.Scan.FORMATS))
        val result = Intent().putExtra(Intents.Scan.RESULT, "https://desk.trycloudflare.com/")
            .putExtra(Intents.Scan.RESULT_FORMAT, "QR_CODE")
        assertTrue(connection.onActivityResult(scan.requestCode, Activity.RESULT_OK, result))
        assertEquals(listOf("https://desk.trycloudflare.com/"), opened)
        PocketConnection(activity, { opened.add(it) }, {}).openComputer()
        assertEquals(2, opened.size)
        assertEquals(opened[0], opened[1])
    }

    @Test fun captureActivityStartsAndRequestsCameraPermissionInsteadOfCrashing() {
        shadowOf(RuntimeEnvironment.getApplication()).denyPermissions(Manifest.permission.CAMERA)
        connection.scan()
        val intent = shadowOf(activity).nextStartedActivityForResult.intent
        val controller = Robolectric.buildActivity(CaptureActivity::class.java, intent)
        try {
            val scanner = controller.create().start().resume().get()
            assertArrayEquals(arrayOf(Manifest.permission.CAMERA), shadowOf(scanner).lastRequestedPermission.requestedPermissions)
            scanner.onRequestPermissionsResult(250, arrayOf(Manifest.permission.CAMERA),
                intArrayOf(PackageManager.PERMISSION_DENIED))
            assertTrue(opened.isEmpty())
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test fun allowsPocketPublicNamedTunnelAndPrivateLanUrls() {
        listOf("https://desk.trycloudflare.com", "https://dsh.example.org:8443/",
            "http://10.3.2.1:3081/", "http://192.168.1.22:3081", "http://172.16.0.1:3081/").forEach {
            assertNotNull(it, PocketConnection.normalize(it))
        }
    }

    @Test fun rejectsNonWebSchemesLoopbackAndUnauthenticatedPublicHttp() {
        listOf("javascript:alert(1)", "file:///data/data/com.dshphone/private", "dsh-phone://service/restart",
            "http://example.org/", "http://172.32.0.1:3081", "http://127.0.0.1:3080/",
            "https://localhost/", "https://127.0.0.2/", "https://2130706433/", "https://127.000.0.1/",
            "https://user:password@example.org/", "https://desk.example.org:0/",
            "https://desk.example.org/path", "https://desk.example.org/#fragment",
            "https://desk.example.org\\@evil.example/").forEach {
            assertNull(it, PocketConnection.normalize(it))
        }
    }

    @Test fun optionalQrPasswordIsUsedOnceAndNeverSavedInConnectionRecord() {
        assertTrue(connection.connect("https://desk.example.org/?token=12345678"))
        assertEquals("https://desk.example.org/?token=12345678", opened.single())
        assertEquals("https://desk.example.org/", connection.savedUrl())
    }

    @Test fun invalidScanAndCancellationPreservePreviousComputerAndOldPeerData() {
        val peer = activity.getSharedPreferences("existing-peer", Activity.MODE_PRIVATE)
        peer.edit().putString("marker", "original").commit()
        assertTrue(connection.connect("https://old.example.org/"))
        val bad = Intent().putExtra(Intents.Scan.RESULT, "dsh-phone://service/restart")
        assertTrue(connection.onActivityResult(PocketConnection.REQUEST_CODE, Activity.RESULT_OK, bad))
        assertTrue(connection.onActivityResult(PocketConnection.REQUEST_CODE, Activity.RESULT_CANCELED, null))
        assertFalse(connection.onActivityResult(2401, Activity.RESULT_OK, bad))
        assertEquals("https://old.example.org/", connection.savedUrl())
        assertEquals(1, opened.size)
        assertEquals("original", peer.getString("marker", null))
    }

    @Test fun originMatchingAllowsLoginRedirectButRejectsOtherPortsHostsAndCredentials() {
        val url = "https://desk.example.org/"
        assertTrue(PocketConnection.sameOrigin("https://desk.example.org:443/pocket-login", url))
        assertFalse(PocketConnection.sameOrigin("http://desk.example.org/", url))
        assertFalse(PocketConnection.sameOrigin("https://desk.example.org:8443/", url))
        assertFalse(PocketConnection.sameOrigin("https://desk.example.org.evil.test/", url))
        assertFalse(PocketConnection.sameOrigin("https://user@desk.example.org/", url))
    }
}
