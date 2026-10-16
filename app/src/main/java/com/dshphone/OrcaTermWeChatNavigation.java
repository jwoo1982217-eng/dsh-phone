package com.dshphone;

import java.net.URI;

/** 腾讯登录页发起的小程序链接交给微信，保留原登录页和 Cookie。 */
public final class OrcaTermWeChatNavigation {
    private OrcaTermWeChatNavigation() {}

    public static boolean shouldOpen(String source, String target, boolean mainFrame) {
        if (!mainFrame || source == null || target == null) return false;
        try {
            URI from = URI.create(source), to = URI.create(target);
            boolean trusted = "orcaterm.cloud.tencent.com".equals(from.getHost()) ||
                "cloud.tencent.com".equals(from.getHost());
            return trusted && "https".equals(from.getScheme()) &&
                from.getRawUserInfo() == null && (from.getPort() == -1 || from.getPort() == 443) &&
                "weixin".equals(to.getScheme()) && "dl".equals(to.getHost()) &&
                "/business/".equals(to.getRawPath()) && to.getRawUserInfo() == null &&
                to.getPort() == -1 && to.getRawFragment() == null &&
                to.getRawQuery() != null && to.getRawQuery().matches("t=[A-Za-z0-9_-]+");
        } catch (IllegalArgumentException error) {
            return false;
        }
    }
}
