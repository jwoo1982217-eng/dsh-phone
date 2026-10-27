package com.dshphone.update;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/** All connections are in-process fixtures: these tests never access GitHub. */
public class PhoneUpdateClientTest {
    private static final byte[] APK = "fixture-apk-bytes".getBytes(StandardCharsets.UTF_8);
    private static final String SHA = PhoneUpdateClient.hex(PhoneUpdateClient.sha256().digest(APK));
    private static final String NAME = UpdateArtifactPolicy.apkName("v0.2.13");
    private static final URI APK_URI = URI.create("https://github.com/jwoo1982217-eng/dsh-phone/releases/download/v0.2.13/" + NAME);
    private static final URI CDN = URI.create("https://release-assets.githubusercontent.com/github-production-release-asset/123/uuid?sig=fixture");

    @Test public void constructionNeverChecksAutomaticallyAnd404IsNotUpToDate() throws Exception {
        List<URI> requests = new ArrayList<>(); FakeConnection missing = new FakeConnection(404, new byte[0]);
        PhoneUpdateClient client = new PhoneUpdateClient(uri -> { requests.add(uri); return missing; });
        assertTrue(requests.isEmpty());
        assertNull(client.checkLatest(new PhoneUpdateClient.Cancel()));
        assertEquals(Arrays.asList(URI.create(UpdateArtifactPolicy.API)), requests); assertTrue(missing.disconnected);
        assertFalse(missing.getInstanceFollowRedirects()); assertNull(missing.getRequestProperty("Authorization"));
    }
    @Test public void rejectsApiRedirectsRateLimitsAndOversizedResponses() throws Exception {
        for (int status : new int[]{302, 403, 429, 500}) {
            FakeConnection response = new FakeConnection(status, new byte[0]);
            expectFailure(() -> new PhoneUpdateClient(uri -> response).checkLatest(new PhoneUpdateClient.Cancel()));
            assertTrue(response.disconnected);
        }
        FakeConnection huge = new FakeConnection(200, new byte[0]); huge.length = PhoneUpdateClient.MAX_METADATA_BYTES + 1;
        expectFailure(() -> new PhoneUpdateClient(uri -> huge).checkLatest(new PhoneUpdateClient.Cancel()));
        assertEquals(0, huge.inputRequests);
    }
    @Test public void downloadsOnlyCompleteDigestMatchedBytesWithExplicitTimeouts() throws Exception {
        FakeConnection response = new FakeConnection(200, APK);
        File output = Files.createTempFile("phone-update-test-", ".part").toFile();
        try {
            List<Long> progress = new ArrayList<>();
            String result = new PhoneUpdateClient(uri -> response).download(release(SHA), output, new PhoneUpdateClient.Cancel(), (n, total) -> progress.add(n));
            assertEquals(SHA, result); assertArrayEquals(APK, Files.readAllBytes(output.toPath()));
            assertEquals(Long.valueOf(APK.length), progress.get(progress.size() - 1));
            assertEquals(15000, response.getConnectTimeout()); assertEquals(20000, response.getReadTimeout());
            assertTrue(response.disconnected); assertFalse(response.getInstanceFollowRedirects());
        } finally { output.delete(); }
    }
    @Test public void refusesTruncatedExcessAndDigestMismatchedDownloadsAndDeletesPartialFile() throws Exception {
        for (byte[] body : new byte[][] { Arrays.copyOf(APK, APK.length - 1), Arrays.copyOf(APK, APK.length + 1), "not-the-original".getBytes(StandardCharsets.UTF_8) }) {
            FakeConnection response = new FakeConnection(200, body); response.length = -1;
            File output = Files.createTempFile("phone-update-test-", ".part").toFile();
            expectFailure(() -> new PhoneUpdateClient(uri -> response).download(release(SHA), output, new PhoneUpdateClient.Cancel(), null));
            assertFalse(output.exists()); assertTrue(response.disconnected);
        }
        FakeConnection wrongLength = new FakeConnection(200, APK); wrongLength.length = APK.length + 1;
        File output = Files.createTempFile("phone-update-test-", ".part").toFile();
        expectFailure(() -> new PhoneUpdateClient(uri -> wrongLength).download(release(SHA), output, new PhoneUpdateClient.Cancel(), null));
        assertFalse(output.exists()); assertEquals(0, wrongLength.inputRequests);
    }
    @Test public void untrustedRedirectIsRejectedBeforeSecondRequest() throws Exception {
        for (String target : Arrays.asList("http://github.com/file.apk", "https://evil.test/file.apk", "https://github.com/kelai141/dsh-mobile-apk/releases/download/v1/app.apk")) {
            List<URI> requests = new ArrayList<>(); FakeConnection redirect = new FakeConnection(302, new byte[0]); redirect.location = target;
            PhoneUpdateClient client = new PhoneUpdateClient(uri -> { requests.add(uri); return redirect; });
            File output = Files.createTempFile("phone-update-test-", ".part").toFile();
            expectFailure(() -> client.download(release(SHA), output, new PhoneUpdateClient.Cancel(), null));
            assertEquals(1, requests.size()); assertFalse(output.exists());
        }
    }
    @Test public void githubSignedCdnRedirectRetainsDigestAndSizeValidation() throws Exception {
        List<URI> requests = new ArrayList<>();
        PhoneUpdateClient client = new PhoneUpdateClient(uri -> { requests.add(uri);
            FakeConnection response = new FakeConnection(uri.equals(APK_URI) ? 302 : 200, uri.equals(APK_URI) ? new byte[0] : APK);
            response.location = CDN.toString(); return response; });
        File output = Files.createTempFile("phone-update-test-", ".part").toFile();
        try { assertEquals(SHA, client.download(release(SHA), output, new PhoneUpdateClient.Cancel(), null));
            assertEquals(Arrays.asList(APK_URI, CDN), requests);
        } finally { output.delete(); }
    }
    @Test public void cancellationDisconnectsAndNeverKeepsPartialApk() throws Exception {
        PhoneUpdateClient.Cancel cancel = new PhoneUpdateClient.Cancel();
        FakeConnection response = new FakeConnection(200, APK) {
            @Override public InputStream getInputStream() {
                return new FilterInputStream(new ByteArrayInputStream(APK)) {
                    @Override public int read(byte[] b, int o, int n) throws IOException {
                        int count = super.read(b, o, n); cancel.cancel(); return count;
                    }
                };
            }
        };
        File output = Files.createTempFile("phone-update-test-", ".part").toFile();
        expectFailure(() -> new PhoneUpdateClient(uri -> response).download(release(SHA), output, cancel, null));
        assertFalse(output.exists()); assertTrue(response.disconnected);
        PhoneUpdateClient.Cancel before = new PhoneUpdateClient.Cancel(); before.cancel();
        expectFailure(() -> new PhoneUpdateClient(uri -> { fail("Cancelled request must not open a connection"); return response; }).checkLatest(before));
    }
    @Test public void namedChecksumMustMatchGithubDigestBeforeApkDownload() throws Exception {
        URI checksum = URI.create(APK_URI + ".sha256"); List<URI> requests = new ArrayList<>();
        PhoneUpdateClient.Release release = new PhoneUpdateClient.Release("v0.2.13", NAME, APK_URI, checksum, "sha256:" + SHA, APK.length);
        byte[] badChecksum = ("c".repeat(64) + "  " + NAME).getBytes(StandardCharsets.UTF_8);
        File output = Files.createTempFile("phone-update-test-", ".part").toFile();
        try {
            expectFailure(() -> new PhoneUpdateClient(uri -> { requests.add(uri); return new FakeConnection(200, badChecksum); })
                    .download(release, output, new PhoneUpdateClient.Cancel(), null));
            assertEquals(Arrays.asList(checksum), requests);
            assertFalse("A failed checksum must also remove the pending file", output.exists());
        } finally { output.delete(); }
    }

    private static PhoneUpdateClient.Release release(String sha) {
        return new PhoneUpdateClient.Release("v0.2.13", NAME, APK_URI, null, "sha256:" + sha, APK.length);
    }
    private interface Checked { void run() throws Exception; }
    private static void expectFailure(Checked action) throws Exception {
        try { action.run(); fail("Expected IOException"); } catch (IOException expected) { }
    }
    private static class FakeConnection extends HttpURLConnection {
        final int status; final byte[] body; long length; String location; boolean disconnected; int inputRequests;
        FakeConnection(int status, byte[] body) throws java.net.MalformedURLException {
            super(new java.net.URL(UpdateArtifactPolicy.API)); this.status = status; this.body = body; length = body.length;
        }
        @Override public int getResponseCode() { return status; }
        @Override public long getContentLengthLong() { return length; }
        @Override public String getHeaderField(String key) { return "Location".equals(key) ? location : null; }
        @Override public InputStream getInputStream() { inputRequests++; return new ByteArrayInputStream(body); }
        @Override public void disconnect() { disconnected = true; }
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() { }
    }
}
