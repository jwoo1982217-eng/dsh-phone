package com.dshphone;

import org.junit.Test;
import static org.junit.Assert.*;

public class EacLoginNavigationTest {
    private static final String LOCAL = "http://127.0.0.1:3080/";
    private static final String LOGIN = "https://ourfreemodel.beichenapi.com/eac/auth/github/start?link=abcdefghijklmnop_1234567";

    @Test public void independentPhoneAuthorizationUsesExternalBrowser() {
        assertTrue(EacLoginNavigation.shouldOpenExternally(LOCAL, LOGIN, true));
        assertTrue(EacLoginNavigation.shouldOpenExternally(LOCAL + "?launch=example", LOGIN.replace(".com/", ".com:443/"), true));
    }

    @Test public void remotePagesOtherFramesAndUnknownUrlsStayOutsideThisRoute() {
        for (String source : new String[]{null, "https://github.com/", "http://192.168.31.241:3080/", "http://127.0.0.1:3081/", "http://name@127.0.0.1:3080/", "file:///local"})
            assertFalse(EacLoginNavigation.shouldOpenExternally(source, LOGIN, true));
        assertFalse(EacLoginNavigation.shouldOpenExternally(LOCAL, LOGIN, false));
        for (String target : new String[]{null, "javascript:alert(1)", LOGIN.replace("https:", "http:"), LOGIN.replace(".com/", ".com.evil.invalid/"), LOGIN.replace(".com/", ".com:444/"), LOGIN.replace("https://", "https://name@"), LOGIN.replace("/start?", "/other?"), LOGIN + "#fragment", LOGIN + "&link=duplicate", LOGIN + "&redirect=https://evil.invalid", LOGIN.replace("abcdefghijklmnop_1234567", "short")})
            assertFalse(EacLoginNavigation.shouldOpenExternally(LOCAL, target, true));
    }
}
