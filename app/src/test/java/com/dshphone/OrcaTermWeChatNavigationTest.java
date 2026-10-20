package com.dshphone;

import org.junit.Test;
import static org.junit.Assert.*;

public class OrcaTermWeChatNavigationTest {
    private static final String SOURCE = "https://orcaterm.cloud.tencent.com/terminal";
    private static final String LINK = "weixin://dl/business/?t=test_login_123";

    @Test public void officialMiniProgramLinkIsHandled() {
        assertTrue(OrcaTermWeChatNavigation.shouldOpen(SOURCE, LINK, true));
        assertTrue(OrcaTermWeChatNavigation.shouldOpen("https://cloud.tencent.com/login", LINK, true));
    }

    @Test public void unrelatedNavigationStaysInItsCurrentRouter() {
        for (String target : new String[]{null, "https://cloud.tencent.com/login", "weixin://dl/scan", LINK.replace("t=", "x="), LINK + "&other=value", LINK.replace("test_login_123", ""), LINK + "#fragment", LINK.replace("dl/", "user@dl/"), LINK.replace("dl/", "dl:443/"), "intent://dl/business/"}) {
            assertFalse(OrcaTermWeChatNavigation.shouldOpen(SOURCE, target, true));
        }
    }

    @Test public void invalidOriginIsRejectedAndTheNextValidLoginStillWorks() {
        for (String source : new String[]{null, "about:blank", SOURCE.replace("https:", "http:"), SOURCE.replace(".com/", ".com.evil.test/"), SOURCE.replace("https://", "https://user@"), SOURCE.replace(".com/", ".com:444/")}) {
            assertFalse(OrcaTermWeChatNavigation.shouldOpen(source, LINK, true));
        }
        assertFalse(OrcaTermWeChatNavigation.shouldOpen(SOURCE, LINK, false));
        assertTrue(OrcaTermWeChatNavigation.shouldOpen(SOURCE, LINK, true));
    }
}
