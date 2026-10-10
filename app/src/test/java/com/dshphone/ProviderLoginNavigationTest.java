package com.dshphone;

import org.junit.Test;
import static org.junit.Assert.*;

public class ProviderLoginNavigationTest {
    private static final String LOCAL = "http://127.0.0.1:3080/";
    private static final String LOGIN = "https://www.workbuddy.ai/login?platform=workbuddy-ai&state=sample-state";

    @Test public void officialLoginPreservesItsCompleteQuery() {
        assertTrue(ProviderLoginNavigation.shouldOpenWorkBuddyExternally(LOCAL, LOGIN, true));
        assertTrue(ProviderLoginNavigation.shouldOpenWorkBuddyExternally(LOCAL + "?page=settings", LOGIN + "&version=5.5.2&loginSessionId=sample", true));
        assertTrue(ProviderLoginNavigation.shouldOpenWorkBuddyExternally(LOCAL, LOGIN.replace(".ai/", ".ai:443/"), true));
    }

    @Test public void onlyThePhoneMainFrameCanOpenTheBrowser() {
        for (String source : new String[]{null, "about:blank", "https://example.test/", "http://127.0.0.1:3081/", "http://localhost:3080/", "http://user@127.0.0.1:3080/"}) {
            assertFalse(ProviderLoginNavigation.shouldOpenWorkBuddyExternally(source, LOGIN, true));
        }
        assertFalse(ProviderLoginNavigation.shouldOpenWorkBuddyExternally(LOCAL, LOGIN, false));
    }

    @Test public void lookalikeAndNonLoginDestinationsStayInsideTheExistingRouter() {
        for (String target : new String[]{null, LOGIN.replace("https:", "http:"), LOGIN.replace("www.workbuddy.ai", "www.workbuddy.ai.example.test"), LOGIN.replace("www.workbuddy.ai", "user@www.workbuddy.ai"), LOGIN.replace("/login?", "/login/other?"), LOGIN.replace(".ai/", ".ai:444/"), LOGIN + "#fragment", "https://auth.openai.com/api/accounts/authorize", "dsh-phone://browser"}) {
            assertFalse(ProviderLoginNavigation.shouldOpenWorkBuddyExternally(LOCAL, target, true));
        }
    }

    @Test public void missingOrAmbiguousAuthorizationIsRejectedAndAValidRetryWorks() {
        for (String target : new String[]{"https://www.workbuddy.ai/login", LOGIN.replace("workbuddy-ai", "codebuddy"), LOGIN.replace("sample-state", ""), LOGIN.replace("sample-state", "%20"), LOGIN + "&state=second", LOGIN + "&platform=codebuddy", LOGIN + "&%73tate=second", LOGIN.replace("sample-state", "%ZZ")}) {
            assertFalse(ProviderLoginNavigation.shouldOpenWorkBuddyExternally(LOCAL, target, true));
        }
        assertTrue(ProviderLoginNavigation.shouldOpenWorkBuddyExternally(LOCAL, LOGIN, true));
    }
}
