package com.dshphone.update;

import static org.junit.Assert.*;
import java.net.URI;
import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;

public class UpdateArtifactPolicyTest {
    private static final String SHA = "a".repeat(64);
    private static final String SIGNER = "b".repeat(64);
    private static final String NAME = "dsh-phone-v0.2.13-arm64-v8a.apk";
    private static final String URL = "https://github.com/jwoo1982217-eng/dsh-phone/releases/download/v0.2.13/" + NAME;

    @Test public void acceptsOnlyTheOwnedRepositoryAndHttps() {
        assertTrue(UpdateArtifactPolicy.isApiUri(URI.create(UpdateArtifactPolicy.API)));
        assertFalse(UpdateArtifactPolicy.isApiUri(URI.create(UpdateArtifactPolicy.API + "?token=x")));
        for (String url : Arrays.asList(URL.replace("https:", "http:"), URL.replace("github.com/", "github.com.evil/"),
                URL.replace("jwoo1982217-eng", "kelai141"), URL.replace("github.com/", "x@github.com/"),
                URL + "#fragment", URL.replace("github.com/", "github.com:444/"), URL + "?anything=1")) {
            assertFalse(url, UpdateArtifactPolicy.isAssetUri(URI.create(url), "v0.2.13", NAME));
        }
        assertTrue(UpdateArtifactPolicy.isAssetUri(URI.create(URL), "v0.2.13", NAME));
    }
    @Test public void redirectAllowsOnlyGithubReleaseAssetCdn() {
        assertTrue(UpdateArtifactPolicy.isCdnUri(URI.create("https://release-assets.githubusercontent.com/github-production-release-asset/123/uuid?sig=x")));
        for (String url : Arrays.asList("https://evil.com/file.apk", "http://release-assets.githubusercontent.com/github-production-release-asset/123/x",
                "https://release-assets.githubusercontent.com/other/x", "https://user@release-assets.githubusercontent.com/github-production-release-asset/123/x",
                "https://release-assets.githubusercontent.com.evil/github-production-release-asset/123/x")) {
            assertFalse(url, UpdateArtifactPolicy.isCdnUri(URI.create(url)));
        }
    }
    @Test public void assetNameCannotEscapeOrSelectAnotherArchitecture() {
        assertEquals(NAME, UpdateArtifactPolicy.apkName("v0.2.13"));
        reject(() -> UpdateArtifactPolicy.apkName("../v0.2.13"));
        reject(() -> UpdateArtifactPolicy.apkName("v0.2.13%2fother"));
        assertFalse(UpdateArtifactPolicy.isAssetUri(URI.create(URL.replace("arm64-v8a", "x86_64")), "v0.2.13", NAME));
    }
    @Test public void acceptsDigestOrNamedChecksumButNotMissingOrAmbiguousHashes() {
        assertEquals(SHA, UpdateArtifactPolicy.expectedSha256("sha256:" + SHA, null, NAME));
        assertEquals(SHA, UpdateArtifactPolicy.expectedSha256(null, SHA + "  " + NAME + "\n", NAME));
        assertEquals(SHA, UpdateArtifactPolicy.expectedSha256(null, SHA + " *" + NAME, NAME));
        reject(() -> UpdateArtifactPolicy.expectedSha256(null, null, NAME));
        reject(() -> UpdateArtifactPolicy.expectedSha256("md5:" + SHA, null, NAME));
        reject(() -> UpdateArtifactPolicy.expectedSha256(null, SHA + "  wrong.apk", NAME));
        reject(() -> UpdateArtifactPolicy.expectedSha256(null, SHA + "  " + NAME + "\n" + SHA + "  " + NAME, NAME));
        reject(() -> UpdateArtifactPolicy.expectedSha256("sha256:" + SHA, "c".repeat(64) + "  " + NAME, NAME));
    }
    @Test public void acceptsOnlyExactBytesDigestIdentityNewVersionAndInstalledSigner() {
        assertNull(verdict(120, 120, SHA, SHA, "com.dshphone", "com.dshphone", 117, 118, SIGNER, SIGNER));
        assertNotNull(verdict(120, 119, SHA, SHA, "com.dshphone", "com.dshphone", 117, 118, SIGNER, SIGNER));
        assertNotNull(verdict(0, 0, SHA, SHA, "com.dshphone", "com.dshphone", 117, 118, SIGNER, SIGNER));
        assertNotNull(verdict(120, 120, SHA, "c".repeat(64), "com.dshphone", "com.dshphone", 117, 118, SIGNER, SIGNER));
        assertNotNull(verdict(120, 120, null, SHA, "com.dshphone", "com.dshphone", 117, 118, SIGNER, SIGNER));
        assertNotNull(verdict(120, 120, SHA, SHA, "com.dshphone", "com.dsharnessmobile", 117, 118, SIGNER, SIGNER));
        assertNotNull(verdict(120, 120, SHA, SHA, "com.dshphone", "com.dshphone", 117, 117, SIGNER, SIGNER));
        assertNotNull(verdict(120, 120, SHA, SHA, "com.dshphone", "com.dshphone", 117, 116, SIGNER, SIGNER));
        assertNotNull(verdict(120, 120, SHA, SHA, "com.dshphone", "com.dshphone", 117, 118, SIGNER, "c".repeat(64)));
        assertNotNull(UpdateArtifactPolicy.artifactError(120, 120, SHA, SHA, "com.dshphone", "com.dshphone", 117, 118,
                Collections.emptySet(), Collections.emptySet()));
    }
    @Test public void installedMultipleSignersMustMatchAsASetExactly() {
        assertNull(UpdateArtifactPolicy.artifactError(120, 120, SHA, SHA, "com.dshphone", "com.dshphone", 117, 118,
                new java.util.HashSet<>(Arrays.asList(SIGNER, SHA)), new java.util.HashSet<>(Arrays.asList(SHA, SIGNER))));
        assertNotNull(UpdateArtifactPolicy.artifactError(120, 120, SHA, SHA, "com.dshphone", "com.dshphone", 117, 118,
                new java.util.HashSet<>(Arrays.asList(SIGNER, SHA)), Collections.singleton(SIGNER)));
    }
    @Test public void sizeIsBoundedBeforeDownload() {
        assertTrue(UpdateArtifactPolicy.validApkSize(1));
        assertTrue(UpdateArtifactPolicy.validApkSize(UpdateArtifactPolicy.MAX_APK_BYTES));
        assertFalse(UpdateArtifactPolicy.validApkSize(0));
        assertFalse(UpdateArtifactPolicy.validApkSize(-1));
        assertFalse(UpdateArtifactPolicy.validApkSize(UpdateArtifactPolicy.MAX_APK_BYTES + 1));
    }
    private static String verdict(long expected, long actual, String digest, String actualDigest, String own, String candidate,
            long installed, long next, String currentSigner, String nextSigner) {
        return UpdateArtifactPolicy.artifactError(expected, actual, digest, actualDigest, own, candidate, installed, next,
                Collections.singleton(currentSigner), Collections.singleton(nextSigner));
    }
    private static void reject(Runnable runnable) {
        try { runnable.run(); fail("Expected rejection"); } catch (IllegalArgumentException expected) { }
    }
}
