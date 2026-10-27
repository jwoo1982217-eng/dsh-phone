package com.dshphone.update;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/** Nothing runs until a caller explicitly invokes checkLatest or download. No token or mirror. */
final class PhoneUpdateClient {
    static final int MAX_METADATA_BYTES = 1024 * 1024;
    static final int MAX_CHECKSUM_BYTES = 8192;
    interface ConnectionFactory { HttpURLConnection open(URI uri) throws IOException; }
    interface Progress { void downloaded(long bytes, long expected); }
    private final ConnectionFactory connections;

    PhoneUpdateClient() { this(uri -> (HttpURLConnection) uri.toURL().openConnection()); }
    PhoneUpdateClient(ConnectionFactory factory) { connections = factory; }

    static final class Cancel {
        private final AtomicBoolean cancelled = new AtomicBoolean();
        private volatile HttpURLConnection active;
        void cancel() { cancelled.set(true); HttpURLConnection c = active; if (c != null) c.disconnect(); }
        boolean isCancelled() { return cancelled.get(); }
        void check() throws IOException {
            if (cancelled.get() || Thread.currentThread().isInterrupted()) throw new IOException("操作已取消");
        }
        void use(HttpURLConnection connection) throws IOException {
            active = connection;
            if (cancelled.get()) { connection.disconnect(); check(); }
        }
        void clear(HttpURLConnection connection) { if (active == connection) active = null; }
    }

    static final class Release {
        final String tag, name, digest;
        final URI apk, checksum;
        final long size;
        Release(String tag, String name, URI apk, URI checksum, String digest, long size) {
            this.tag = tag; this.name = name; this.apk = apk; this.checksum = checksum;
            this.digest = digest; this.size = size;
        }
    }

    /** Null means GitHub has no public stable release (HTTP 404), not "already up to date". */
    Release checkLatest(Cancel cancel) throws IOException {
        URI api = URI.create(UpdateArtifactPolicy.API);
        HttpURLConnection connection = open(api, cancel, true);
        try {
            int status = connection.getResponseCode();
            if (status == 404) return null;
            requireOk(status);
            String body = new String(readBounded(connection, MAX_METADATA_BYTES, cancel, 30000), StandardCharsets.UTF_8);
            return parseRelease(body);
        } finally { connection.disconnect(); cancel.clear(connection); }
    }

    static Release parseRelease(String body) throws IOException {
        try {
            JSONObject json = new JSONObject(body);
            if (json.optBoolean("draft", false) || json.optBoolean("prerelease", false))
                throw new IOException("最新发布不是正式稳定版，未选择安装包");
            String tag = json.getString("tag_name");
            String name = UpdateArtifactPolicy.apkName(tag);
            JSONArray assets = json.getJSONArray("assets");
            JSONObject apk = null, checksum = null;
            for (int i = 0; i < assets.length(); i++) {
                JSONObject item = assets.getJSONObject(i);
                if (name.equals(item.optString("name"))) {
                    if (apk != null) throw new IOException("发布中有重复 APK 资产");
                    apk = item;
                }
                if ((name + ".sha256").equals(item.optString("name"))) {
                    if (checksum != null) throw new IOException("发布中有重复 SHA256 资产");
                    checksum = item;
                }
            }
            if (apk == null) throw new IOException("此发布尚未提供本增强版的 arm64-v8a APK（" + name + "）");
            if (!"uploaded".equals(apk.optString("state"))) throw new IOException("APK 资产尚未完成上传");
            long size = apk.getLong("size");
            if (!UpdateArtifactPolicy.validApkSize(size)) throw new IOException("发布 APK 大小无效或超过 512 MiB");
            URI apkUri = URI.create(apk.getString("browser_download_url"));
            if (!UpdateArtifactPolicy.isAssetUri(apkUri, tag, name)) throw new IOException("APK 下载地址不属于本增强版仓库");
            String digest = apk.isNull("digest") ? null : apk.optString("digest", null);
            URI checksumUri = null;
            if (checksum != null) {
                checksumUri = URI.create(checksum.getString("browser_download_url"));
                if (!"uploaded".equals(checksum.optString("state"))
                        || checksum.optLong("size", -1) < 1 || checksum.optLong("size", -1) > MAX_CHECKSUM_BYTES
                        || !UpdateArtifactPolicy.isAssetUri(checksumUri, tag, name + ".sha256"))
                    throw new IOException("SHA256 资产未就绪或地址无效");
            }
            if (digest == null || digest.isEmpty()) {
                if (checksumUri == null) throw new IOException("发布未附 SHA256 摘要或校验文件，不能安全更新");
            } else UpdateArtifactPolicy.expectedSha256(digest, null, name);
            return new Release(tag, name, apkUri, checksumUri, digest, size);
        } catch (JSONException | IllegalArgumentException e) { throw new IOException("发布信息无效：" + e.getMessage(), e); }
    }

    /** Destination must be private, non-shared pending storage. Any failure deletes partial bytes. */
    String download(Release release, File destination, Cancel cancel, Progress progress) throws IOException {
        boolean complete = false;
        try {
            String checksum = null;
            if (release.checksum != null) {
                try (Response response = asset(release.checksum, release, release.name + ".sha256", cancel)) {
                    checksum = new String(readBounded(response.connection, MAX_CHECKSUM_BYTES, cancel, 30000), StandardCharsets.UTF_8);
                }
            }
            final String expected;
            try { expected = UpdateArtifactPolicy.expectedSha256(release.digest, checksum, release.name); }
            catch (IllegalArgumentException e) { throw new IOException(e.getMessage(), e); }
            if (!UpdateArtifactPolicy.validApkSize(release.size)) throw new IOException("APK 大小无效");
            try (Response response = asset(release.apk, release, release.name, cancel)) {
                long contentLength = response.connection.getContentLengthLong();
                if (contentLength >= 0 && contentLength != release.size) throw new IOException("服务器 Content-Length 与发布大小不一致");
                MessageDigest sha = sha256();
                long total = 0, deadline = System.nanoTime() + 10L * 60 * 1000000000;
                byte[] buffer = new byte[64 * 1024];
                try (InputStream in = response.connection.getInputStream(); FileOutputStream out = new FileOutputStream(destination)) {
                    while (true) {
                        checkDeadline(cancel, deadline);
                        int read = in.read(buffer);
                        if (read == -1) break;
                        total += read;
                        if (total > release.size) throw new IOException("下载内容超过发布大小");
                        out.write(buffer, 0, read); sha.update(buffer, 0, read);
                        if (progress != null) progress.downloaded(total, release.size);
                    }
                    out.getFD().sync();
                }
                if (total != release.size) throw new IOException("安装包下载被截断，已删除不完整文件");
                if (!expected.equals(hex(sha.digest()))) throw new IOException("安装包 SHA256 不匹配，已拒绝安装");
                cancel.check(); complete = true; return expected;
            }
        } finally { if (!complete && destination.exists() && !destination.delete()) destination.deleteOnExit(); }
    }

    private Response asset(URI uri, Release release, String name, Cancel cancel) throws IOException {
        if (!UpdateArtifactPolicy.isAssetUri(uri, release.tag, name)) throw new IOException("非可信仓库下载地址");
        URI current = uri;
        for (int redirects = 0; redirects <= 3; redirects++) {
            HttpURLConnection connection = open(current, cancel, false);
            try {
                int status = connection.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = connection.getHeaderField("Location");
                    if (location == null || location.length() > 20000) throw new IOException("下载重定向无效");
                    URI next;
                    try { next = current.resolve(location); } catch (IllegalArgumentException e) { throw new IOException("下载重定向格式无效", e); }
                    if (!UpdateArtifactPolicy.isCdnUri(next)) throw new IOException("拒绝非 GitHub 发行 CDN 的重定向");
                    current = next;
                    connection.disconnect(); cancel.clear(connection); continue;
                }
                requireOk(status);
                return new Response(connection, cancel);
            } catch (IOException | RuntimeException e) {
                connection.disconnect(); cancel.clear(connection); throw e;
            }
        }
        throw new IOException("下载重定向次数过多");
    }

    private HttpURLConnection open(URI uri, Cancel cancel, boolean api) throws IOException {
        cancel.check();
        if (api && !UpdateArtifactPolicy.isApiUri(uri)) throw new IOException("非可信更新接口");
        HttpURLConnection connection = connections.open(uri);
        connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
        connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
        connection.setRequestProperty("Accept", api ? "application/vnd.github+json" : "application/octet-stream");
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("User-Agent", "DSH-Phone-Manual-Updater");
        if (api) connection.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
        cancel.use(connection); return connection;
    }

    private static void requireOk(int status) throws IOException {
        if (status == 403 || status == 429) throw new IOException("GitHub 接口拒绝访问或已限流（HTTP " + status + "），请稍后手动重试");
        if (status != 200) throw new IOException("更新请求失败（HTTP " + status + "）");
    }
    private static byte[] readBounded(HttpURLConnection connection, int max, Cancel cancel, long millis) throws IOException {
        if (connection.getContentLengthLong() > max) throw new IOException("更新响应超过大小上限");
        long deadline = System.nanoTime() + millis * 1000000;
        try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int read;
            while (true) {
                checkDeadline(cancel, deadline); read = in.read(buffer); if (read == -1) break;
                if (out.size() + read > max) throw new IOException("更新响应超过大小上限");
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        }
    }
    static void checkDeadline(Cancel cancel, long deadline) throws IOException {
        cancel.check(); if (System.nanoTime() > deadline) throw new IOException("更新操作总时限已到，请手动重试");
    }
    static MessageDigest sha256() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }
    private static final class Response implements AutoCloseable {
        final HttpURLConnection connection; final Cancel cancel;
        Response(HttpURLConnection connection, Cancel cancel) { this.connection = connection; this.cancel = cancel; }
        public void close() { connection.disconnect(); cancel.clear(connection); }
    }
}
