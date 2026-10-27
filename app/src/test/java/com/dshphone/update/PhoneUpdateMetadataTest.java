package com.dshphone.update;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class PhoneUpdateMetadataTest {
    private static final String SHA = "a".repeat(64);
    private static final String NAME = "dsh-phone-v0.2.13-arm64-v8a.apk";
    @Test public void selectsOwnedArm64AssetAndMandatoryDigest() throws Exception {
        PhoneUpdateClient.Release release = PhoneUpdateClient.parseRelease(release().toString());
        assertEquals(NAME, release.name); assertEquals("sha256:" + SHA, release.digest); assertEquals(100, release.size);
    }
    @Test public void namedChecksumCanSupplyMissingGithubDigest() throws Exception {
        JSONObject json = release(); JSONObject apk = json.getJSONArray("assets").getJSONObject(0); apk.remove("digest");
        json.getJSONArray("assets").put(asset(NAME + ".sha256").put("size", 160));
        PhoneUpdateClient.Release release = PhoneUpdateClient.parseRelease(json.toString());
        assertNotNull(release.checksum); assertNull(release.digest);
        json.getJSONArray("assets").remove(1); reject(json);
    }
    @Test public void emptyMalformedDraftAndPrereleaseAreNotReportedAsLatestInstalled() throws Exception {
        reject(new JSONObject()); reject(release().put("assets", new JSONArray()));
        reject(release().put("draft", true)); reject(release().put("prerelease", true));
        try { PhoneUpdateClient.parseRelease("<html>upstream unavailable</html>"); fail(); } catch (java.io.IOException expected) { }
    }
    @Test public void rejectsUnownedWrongAbiAndIncompleteOrDuplicateAssets() throws Exception {
        for (String name : new String[]{"dsh-mobile-apk-v0.14.8-arm64.apk", NAME.replace("arm64-v8a", "x86_64")})
            reject(release().put("assets", new JSONArray().put(asset(name))));
        JSONObject json = release(); json.getJSONArray("assets").getJSONObject(0)
                .put("browser_download_url", "https://github.com/kelai141/dsh-mobile-apk/releases/download/v0.2.13/" + NAME); reject(json);
        json = release(); json.getJSONArray("assets").getJSONObject(0).put("state", "new"); reject(json);
        json = release(); json.getJSONArray("assets").put(asset(NAME)); reject(json);
    }
    @Test public void rejectsMalformedTagsSizesAndDigest() throws Exception {
        for (String tag : new String[]{"../v0.2.13", "v0.2.13%2fattack", ""}) reject(release().put("tag_name", tag));
        for (long size : new long[]{0, -1, UpdateArtifactPolicy.MAX_APK_BYTES + 1}) {
            JSONObject json = release(); json.getJSONArray("assets").getJSONObject(0).put("size", size); reject(json);
        }
        JSONObject json = release(); json.getJSONArray("assets").getJSONObject(0).put("digest", "md5:bad"); reject(json);
    }
    @Test public void rejectsWrongChecksumLocationBeforeMakingNetworkRequest() throws Exception {
        JSONObject json = release(); json.getJSONArray("assets").put(asset(NAME + ".sha256")
                .put("browser_download_url", "https://evil.test/" + NAME + ".sha256")); reject(json);
        json = release(); json.getJSONArray("assets").put(asset(NAME + ".sha256").put("size", 8193)); reject(json);
    }
    private static JSONObject release() throws Exception {
        return new JSONObject().put("tag_name", "v0.2.13").put("draft", false).put("prerelease", false)
                .put("assets", new JSONArray().put(asset(NAME)));
    }
    private static JSONObject asset(String name) throws Exception {
        return new JSONObject().put("name", name).put("size", 100).put("state", "uploaded").put("digest", "sha256:" + SHA)
                .put("browser_download_url", "https://github.com/jwoo1982217-eng/dsh-phone/releases/download/v0.2.13/" + name);
    }
    private static void reject(JSONObject json) throws Exception {
        try { PhoneUpdateClient.parseRelease(json.toString()); fail("Expected invalid release to be rejected"); }
        catch (java.io.IOException expected) { }
    }
}
