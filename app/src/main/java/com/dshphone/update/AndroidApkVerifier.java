package com.dshphone.update;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.Set;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** All checks run before a verified APK can be placed inside the FileProvider directory. */
final class AndroidApkVerifier {
    static final class Verified {
        final File file;
        final PhoneUpdateClient.Release release;
        final String sha256, versionName;
        final long versionCode;
        Verified(File file, PhoneUpdateClient.Release release, String sha256, String name, long version) {
            this.file = file; this.release = release; this.sha256 = sha256; versionName = name; versionCode = version;
        }
    }

    static Verified verify(Context context, File file, PhoneUpdateClient.Release release, String expectedSha,
            PhoneUpdateClient.Cancel cancel) throws IOException {
        if (!file.isFile() || file.length() != release.size) throw new IOException("安装包不存在或大小不符");
        long deadline = System.nanoTime() + 5L * 60 * 1000000000;
        MessageDigest sha = PhoneUpdateClient.sha256();
        byte[] bytes = new byte[64 * 1024];
        try (InputStream input = new FileInputStream(file)) {
            int read;
            while (true) {
                PhoneUpdateClient.checkDeadline(cancel, deadline); read = input.read(bytes); if (read == -1) break;
                sha.update(bytes, 0, read);
            }
        }
        String actualSha = PhoneUpdateClient.hex(sha.digest());
        if (!expectedSha.equals(actualSha)) throw new IOException("安装包 SHA256 不匹配");
        verifyZip(file, cancel, deadline);
        cancel.check();
        PackageManager manager = context.getPackageManager();
        PackageInfo installed;
        try { installed = manager.getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES); }
        catch (PackageManager.NameNotFoundException e) { throw new IOException("无法读取当前应用身份", e); }
        PackageInfo candidate = manager.getPackageArchiveInfo(file.getAbsolutePath(), PackageManager.GET_SIGNING_CERTIFICATES);
        if (candidate == null || candidate.applicationInfo == null) throw new IOException("安装包无法解析或签名验证失败");
        if (candidate.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT) throw new IOException("此安装包需要更高的 Android 版本");
        String error = UpdateArtifactPolicy.artifactError(release.size, file.length(), expectedSha, actualSha,
                context.getPackageName(), candidate.packageName, installed.getLongVersionCode(), candidate.getLongVersionCode(),
                signers(installed), signers(candidate));
        if (error != null) throw new IOException(error);
        cancel.check();
        return new Verified(file, release, actualSha, candidate.versionName == null ? "未知" : candidate.versionName,
                candidate.getLongVersionCode());
    }

    private static Set<String> signers(PackageInfo info) {
        Set<String> result = new HashSet<>();
        if (info.signingInfo == null) return result;
        // Current signers only: a different signer in a historical lineage is not accepted implicitly.
        Signature[] current = info.signingInfo.getApkContentsSigners();
        if (current != null) for (Signature signature : current)
            result.add(PhoneUpdateClient.hex(PhoneUpdateClient.sha256().digest(signature.toByteArray())));
        return result;
    }

    private static void verifyZip(File file, PhoneUpdateClient.Cancel cancel, long deadline) throws IOException {
        long expanded = 0; int count = 0; boolean manifest = false, nativeArm64 = false;
        Set<String> names = new HashSet<>();
        try (ZipFile zip = new ZipFile(file)) {
            Enumeration<? extends ZipEntry> entries = zip.entries();
            byte[] buffer = new byte[64 * 1024];
            while (entries.hasMoreElements()) {
                PhoneUpdateClient.checkDeadline(cancel, deadline);
                ZipEntry entry = entries.nextElement();
                if (++count > 30000 || !names.add(entry.getName())) throw new IOException("安装包目录异常或有重复条目");
                if (entry.isDirectory()) continue;
                if (entry.getSize() < 0 || entry.getSize() > UpdateArtifactPolicy.MAX_APK_BYTES)
                    throw new IOException("安装包解压条目大小异常");
                manifest |= "AndroidManifest.xml".equals(entry.getName());
                nativeArm64 |= entry.getName().startsWith("lib/arm64-v8a/") && entry.getName().endsWith(".so");
                CRC32 crc = new CRC32(); long length = 0;
                try (InputStream input = zip.getInputStream(entry)) {
                    int read;
                    while (true) {
                        PhoneUpdateClient.checkDeadline(cancel, deadline); read = input.read(buffer); if (read == -1) break;
                        length += read; expanded += read;
                        if (length > entry.getSize() || expanded > 1024L * 1024 * 1024)
                            throw new IOException("安装包解压体积异常");
                        crc.update(buffer, 0, read);
                    }
                }
                if (length != entry.getSize() || crc.getValue() != entry.getCrc()) throw new IOException("安装包 ZIP 完整性校验失败");
            }
        }
        if (!manifest || !nativeArm64) throw new IOException("不是可用的本增强版 arm64-v8a APK");
    }
    private AndroidApkVerifier() { }
}
