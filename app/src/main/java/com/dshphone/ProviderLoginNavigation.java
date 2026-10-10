package com.dshphone;

import java.net.URI;
import java.net.URLDecoder;
import java.io.UnsupportedEncodingException;
import java.util.HashMap;
import java.util.Map;

/** 只有手机本机页面发起的 WorkBuddy 官方授权才转交系统浏览器。 */
public final class ProviderLoginNavigation {
    private ProviderLoginNavigation() {}

    public static boolean shouldOpenWorkBuddyExternally(String source, String target, boolean mainFrame) {
        if (!mainFrame || source == null || target == null) return false;
        try {
            URI from = URI.create(source);
            URI to = URI.create(target);
            if (!"http".equals(from.getScheme()) || !"127.0.0.1".equals(from.getHost()) ||
                from.getPort() != 3080 || from.getRawUserInfo() != null) return false;
            if (!"https".equals(to.getScheme()) || !"www.workbuddy.ai".equals(to.getHost()) ||
                !"/login".equals(to.getRawPath()) || to.getRawUserInfo() != null ||
                (to.getPort() != -1 && to.getPort() != 443) || to.getRawFragment() != null ||
                to.getRawQuery() == null) return false;
            Map<String, String> values = new HashMap<>();
            for (String part : to.getRawQuery().split("&")) {
                String[] pair = part.split("=", 2);
                String key = decode(pair[0]);
                String value = pair.length == 2 ? decode(pair[1]) : "";
                if (values.putIfAbsent(key, value) != null && ("platform".equals(key) || "state".equals(key))) return false;
            }
            return "workbuddy-ai".equals(values.get("platform")) &&
                values.get("state") != null && !values.get("state").trim().isEmpty();
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private static String decode(String value) {
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (UnsupportedEncodingException error) {
            throw new IllegalArgumentException(error);
        }
    }
}
