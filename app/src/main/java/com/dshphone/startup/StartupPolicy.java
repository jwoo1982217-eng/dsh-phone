package com.dshphone.startup;

import java.util.Locale;

/** Behavior adapted from kelai141/dsh-mobile-apk SplashPolicy (MIT, 1a8f9fb). */
public final class StartupPolicy {
    public static final long MAX_BYTES = 50L * 1024 * 1024;
    public static final long COPY_TIMEOUT_MILLIS = 120000;
    public static final long SPLASH_TIMEOUT_MILLIS = 30000;
    public static boolean autoStart(Boolean stored) { return stored == null || stored; }
    public static boolean validSize(long size) { return size > 0 && size <= MAX_BYTES; }
    public static String rejection(String name, String mime, long declaredBytes) {
        String leaf = displayName(name).toLowerCase(Locale.ROOT);
        if (leaf.endsWith(".ts") || forbiddenMime(mime)) return "forbidden-ts";
        return declaredBytes > MAX_BYTES ? "too-large" : null;
    }
    public static String mediaRejection(boolean hasVideo, long duration, int width, int height, String actualMime) {
        if (forbiddenMime(actualMime)) return "forbidden-ts";
        return !hasVideo || duration <= 0 || width <= 0 || height <= 0 ? "decode-failed" : null;
    }
    private static boolean forbiddenMime(String mime) {
        String normalized = mime == null ? "" : mime.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return normalized.equals("video/mp2t") || normalized.equals("video/vnd.dlna.mpeg-tts");
    }
    public static String displayName(String name) {
        String leaf = name == null ? "" : name.replace('\\', '/');
        leaf = leaf.substring(leaf.lastIndexOf('/') + 1).replaceAll("[\\p{Cntrl}]", "").trim();
        if (leaf.isEmpty()) leaf = "video";
        return leaf.length() > 160 ? leaf.substring(0, 160) : leaf;
    }
    private StartupPolicy() { }
}
