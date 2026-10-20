package com.dshphone;

import java.net.URI;

/** Hand only this device's official EAC authorization link to the system browser. */
public final class EacLoginNavigation {
    private EacLoginNavigation() {}

    public static boolean shouldOpenExternally(String source, String target, boolean mainFrame) {
        if (!mainFrame || source == null || target == null) return false;
        try {
            URI from = URI.create(source);
            URI to = URI.create(target);
            if (!"http".equals(from.getScheme()) || !"127.0.0.1".equals(from.getHost()) ||
                from.getPort() != 3080 || from.getRawUserInfo() != null) return false;
            return "https".equals(to.getScheme()) &&
                "ourfreemodel.beichenapi.com".equals(to.getHost()) &&
                "/eac/auth/github/start".equals(to.getRawPath()) &&
                to.getRawUserInfo() == null && to.getRawFragment() == null &&
                (to.getPort() == -1 || to.getPort() == 443) &&
                to.getRawQuery() != null && to.getRawQuery().matches("link=[A-Za-z0-9_-]{16,64}");
        } catch (IllegalArgumentException error) {
            return false;
        }
    }
}
