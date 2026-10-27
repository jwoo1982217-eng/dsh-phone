package com.dshphone.update;

import java.net.URI;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Offline policy shared by metadata, downloads, and the final installer handoff. */
public final class UpdateArtifactPolicy {
    public static final String REPOSITORY = "jwoo1982217-eng/dsh-phone";
    public static final String API = "https://api.github.com/repos/" + REPOSITORY + "/releases/latest";
    public static final long MAX_APK_BYTES = 512L * 1024 * 1024;
    private static final Pattern TAG = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
    private static final Pattern HASH = Pattern.compile("[a-fA-F0-9]{64}");
    private static final Pattern CHECKSUM = Pattern.compile("([a-fA-F0-9]{64})[ \\t]+\\*?([^\\r\\n]+)");

    private UpdateArtifactPolicy() { }

    public static boolean isApiUri(URI uri) {
        return secure(uri, "api.github.com") && uri.getRawQuery() == null
                && ("/repos/" + REPOSITORY + "/releases/latest").equals(uri.getRawPath());
    }

    public static String apkName(String tag) {
        if (tag == null || !TAG.matcher(tag).matches()) throw new IllegalArgumentException("发布标签格式无效");
        return "dsh-phone-" + tag + "-arm64-v8a.apk";
    }

    public static boolean isAssetUri(URI uri, String tag, String name) {
        try {
            String apk = apkName(tag);
            if (!apk.equals(name) && !(apk + ".sha256").equals(name)) return false;
            return secure(uri, "github.com") && uri.getRawQuery() == null
                    && ("/" + REPOSITORY + "/releases/download/" + tag + "/" + name).equals(uri.getRawPath());
        } catch (IllegalArgumentException e) { return false; }
    }

    public static boolean isCdnUri(URI uri) {
        // Signed GitHub CDN query parameters are opaque; hosts and path family are not.
        return secure(uri, "release-assets.githubusercontent.com")
                && uri.getRawPath() != null
                && uri.getRawPath().matches("/github-production-release-asset/[0-9]+/[A-Za-z0-9._-]+")
                && uri.getRawQuery() != null && uri.getRawQuery().length() <= 16384;
    }

    private static boolean secure(URI uri, String host) {
        return uri != null && "https".equals(uri.getScheme()) && host.equals(uri.getHost())
                && uri.getRawUserInfo() == null && uri.getRawFragment() == null
                && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    public static String expectedSha256(String digest, String checksum, String name) {
        String fromDigest = null;
        if (digest != null && !digest.isEmpty()) {
            if (!digest.startsWith("sha256:") || !HASH.matcher(digest.substring(7)).matches())
                throw new IllegalArgumentException("发布 SHA256 摘要格式无效");
            fromDigest = digest.substring(7).toLowerCase(Locale.ROOT);
        }
        String fromFile = null;
        if (checksum != null) {
            for (String line : checksum.split("\\r?\\n")) {
                if (line.trim().isEmpty()) continue;
                Matcher match = CHECKSUM.matcher(line);
                if (!match.matches() || !name.equals(match.group(2)) || fromFile != null)
                    throw new IllegalArgumentException("SHA256 文件必须只包含这个 APK 的一条校验记录");
                fromFile = match.group(1).toLowerCase(Locale.ROOT);
            }
            if (fromFile == null) throw new IllegalArgumentException("SHA256 文件为空");
        }
        if (fromDigest == null && fromFile == null) throw new IllegalArgumentException("尚未发布 SHA256，不能安全下载更新");
        if (fromDigest != null && fromFile != null && !sameHash(fromDigest, fromFile))
            throw new IllegalArgumentException("发布摘要与 SHA256 文件不一致");
        return fromDigest != null ? fromDigest : fromFile;
    }

    public static boolean validApkSize(long size) { return size > 0 && size <= MAX_APK_BYTES; }

    /** A null result is acceptance; all non-null results must stop the installer. */
    public static String artifactError(long expectedBytes, long actualBytes, String expectedSha, String actualSha,
            String ownPackage, String apkPackage, long installedVersion, long apkVersion,
            Set<String> installedSigners, Set<String> apkSigners) {
        if (!validApkSize(expectedBytes) || actualBytes != expectedBytes) return "安装包大小不符或超过上限";
        if (!validHash(expectedSha) || !validHash(actualSha) || !sameHash(expectedSha, actualSha)) return "安装包 SHA256 不匹配";
        if (ownPackage == null || !ownPackage.equals(apkPackage)) return "安装包身份不同，拒绝替换本应用";
        if (installedVersion < 1 || apkVersion <= installedVersion) return "不是更高 versionCode，拒绝重复安装或降级";
        if (installedSigners == null || apkSigners == null || installedSigners.isEmpty() || apkSigners.isEmpty()
                || !installedSigners.equals(apkSigners)) return "安装包签名与当前应用不同";
        for (String signer : installedSigners) if (!validHash(signer)) return "当前应用签名信息不可验证";
        return null;
    }

    private static boolean validHash(String hash) { return hash != null && HASH.matcher(hash).matches(); }
    private static boolean sameHash(String a, String b) {
        return MessageDigest.isEqual(a.toLowerCase(Locale.ROOT).getBytes(java.nio.charset.StandardCharsets.US_ASCII),
                b.toLowerCase(Locale.ROOT).getBytes(java.nio.charset.StandardCharsets.US_ASCII));
    }
}
