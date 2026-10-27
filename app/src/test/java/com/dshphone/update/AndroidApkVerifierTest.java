package com.dshphone.update;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowPackageManager;

/** Package identity is a PackageManager fixture here; real APK signing is an Android acceptance gate. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class AndroidApkVerifierTest {
    private Context context;
    private ShadowPackageManager packages;
    @Before public void setup() {
        context = RuntimeEnvironment.getApplication(); packages = Shadows.shadowOf(context.getPackageManager());
        packages.installPackage(info(context.getPackageName(), 117, "01020304"));
    }
    @Test public void verifiesZipHashIdentityVersionAndSameSignerBeforeAccepting() throws Exception {
        File file = zip("lib/arm64-v8a/libfixture.so");
        try {
            packages.setPackageArchiveInfo(file.getAbsolutePath(), info(context.getPackageName(), 118, "01020304"));
            AndroidApkVerifier.Verified result = verify(file); assertEquals(118, result.versionCode); assertEquals(file, result.file);
        } finally { file.delete(); }
    }
    @Test public void rejectsDifferentPackageVersionOrSignerAndUnsignedArchive() throws Exception {
        File file = zip("lib/arm64-v8a/libfixture.so");
        try {
            for (PackageInfo candidate : new PackageInfo[]{info("com.dsharnessmobile", 118, "01020304"),
                    info(context.getPackageName(), 117, "01020304"), info(context.getPackageName(), 116, "01020304"),
                    info(context.getPackageName(), 118, "05060708"), info(context.getPackageName(), 118, null)}) {
                packages.setPackageArchiveInfo(file.getAbsolutePath(), candidate); reject(file);
            }
        } finally { file.delete(); }
    }
    @Test public void rejectsUnparseableArchiveAndUnsupportedAndroidVersion() throws Exception {
        File file = zip("lib/arm64-v8a/libfixture.so");
        try {
            packages.setPackageArchiveInfo(file.getAbsolutePath(), null); reject(file);
            PackageInfo candidate = info(context.getPackageName(), 118, "01020304"); candidate.applicationInfo.minSdkVersion = 99;
            packages.setPackageArchiveInfo(file.getAbsolutePath(), candidate); reject(file);
        } finally { file.delete(); }
    }
    @Test public void rejectsZipCorruptionWrongArchitectureAndTruncatedFileEvenWithCurrentHash() throws Exception {
        File wrongAbi = zip("lib/x86_64/libfixture.so");
        try { packages.setPackageArchiveInfo(wrongAbi.getAbsolutePath(), info(context.getPackageName(), 118, "01020304")); reject(wrongAbi); }
        finally { wrongAbi.delete(); }
        File corrupt = zip("lib/arm64-v8a/libfixture.so");
        try {
            // Stored ZIP data CRC deliberately no longer matches; digest is recomputed after corruption.
            byte[] all = Files.readAllBytes(corrupt.toPath()); byte[] marker = "synthetic-native-bytes".getBytes(StandardCharsets.UTF_8);
            int at = index(all, marker); assertTrue(at >= 0); all[at] ^= 1; Files.write(corrupt.toPath(), all);
            packages.setPackageArchiveInfo(corrupt.getAbsolutePath(), info(context.getPackageName(), 118, "01020304")); reject(corrupt);
            try (RandomAccessFile random = new RandomAccessFile(corrupt, "rw")) { random.setLength(20); }
            reject(corrupt);
        } finally { corrupt.delete(); }
    }
    @Test public void preCancelledVerificationNeverAccepts() throws Exception {
        File file = zip("lib/arm64-v8a/libfixture.so");
        try {
            PhoneUpdateClient.Cancel cancellation = new PhoneUpdateClient.Cancel(); cancellation.cancel();
            try { AndroidApkVerifier.verify(context, file, release(file), digest(file), cancellation); fail(); }
            catch (java.io.IOException expected) { }
        } finally { file.delete(); }
    }
    private AndroidApkVerifier.Verified verify(File file) throws Exception {
        return AndroidApkVerifier.verify(context, file, release(file), digest(file), new PhoneUpdateClient.Cancel());
    }
    private void reject(File file) throws Exception {
        try { verify(file); fail("Expected candidate rejection"); } catch (java.io.IOException expected) { }
    }
    private static PhoneUpdateClient.Release release(File file) throws Exception {
        String name = UpdateArtifactPolicy.apkName("v0.2.13");
        return new PhoneUpdateClient.Release("v0.2.13", name, java.net.URI.create("https://github.com/jwoo1982217-eng/dsh-phone/releases/download/v0.2.13/" + name), null,
                "sha256:" + digest(file), file.length());
    }
    private static String digest(File file) throws Exception {
        return PhoneUpdateClient.hex(PhoneUpdateClient.sha256().digest(Files.readAllBytes(file.toPath())));
    }
    private static PackageInfo info(String name, long version, String signature) {
        PackageInfo info = new PackageInfo(); info.packageName = name; info.setLongVersionCode(version); info.versionName = "fixture";
        info.applicationInfo = new ApplicationInfo(); info.applicationInfo.packageName = name; info.applicationInfo.minSdkVersion = 28;
        if (signature != null) { info.signingInfo = new SigningInfo(); Shadows.shadowOf(info.signingInfo).setSignatures(new Signature[]{new Signature(signature)}); }
        return info;
    }
    private static File zip(String library) throws Exception {
        File file = File.createTempFile("update-fixture-", ".apk");
        try (ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(file))) {
            stored(zip, "AndroidManifest.xml", "synthetic-manifest".getBytes(StandardCharsets.UTF_8));
            stored(zip, library, "synthetic-native-bytes".getBytes(StandardCharsets.UTF_8));
        } return file;
    }
    private static void stored(ZipOutputStream zip, String name, byte[] bytes) throws Exception {
        CRC32 crc = new CRC32(); crc.update(bytes); ZipEntry entry = new ZipEntry(name); entry.setMethod(ZipEntry.STORED);
        entry.setSize(bytes.length); entry.setCompressedSize(bytes.length); entry.setCrc(crc.getValue()); zip.putNextEntry(entry); zip.write(bytes); zip.closeEntry();
    }
    private static int index(byte[] all, byte[] marker) {
        for (int i = 0; i <= all.length - marker.length; i++) { int j = 0; while (j < marker.length && all[i + j] == marker[j]) j++; if (j == marker.length) return i; } return -1;
    }
}
