package com.dshphone.browser;
import org.junit.Test;
import static org.junit.Assert.*;
public class BrowserProfilePolicyTest {
    private void reject(Runnable action) { try { action.run(); fail("Expected rejection"); } catch (IllegalArgumentException expected) {} }
    @Test public void viewportBoundsAreExplicit() {
        BrowserProfilePolicy.validate(412,915,"android-real");
        BrowserProfilePolicy.validate(1280,800,"windows-desktop");
        reject(() -> BrowserProfilePolicy.validate(0,800,"android-real"));
        reject(() -> BrowserProfilePolicy.validate(400,5000,"android-real"));
        reject(() -> BrowserProfilePolicy.validate(400,800,"other;desktop"));
    }
    @Test public void letterboxesWithoutStretchingOrNegativeSizes() {
        assertArrayEquals(new int[]{400,0,300,500}, BrowserProfilePolicy.fit(1100,500,480,800,3));
        assertArrayEquals(new int[]{0,0,824,1830}, BrowserProfilePolicy.fit(824,1830,412,915,3));
        reject(() -> BrowserProfilePolicy.fit(0,500,412,915,3));
        reject(() -> BrowserProfilePolicy.fit(500,500,412,915,Double.NaN));
    }
    @Test public void desktopVersionComesFromInstalledEngineOnly() {
        String ua="Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/151.0.7777.18 Mobile Safari/537.36";
        assertEquals("151.0.7777.18", BrowserProfilePolicy.chromeVersion(ua));
        assertTrue(BrowserProfilePolicy.desktopUa(ua).contains("Windows NT 10.0; Win64; x64"));
        assertTrue(BrowserProfilePolicy.desktopUa(ua).contains("Chrome/151.0.7777.18"));
        assertFalse(BrowserProfilePolicy.desktopUa(ua).contains("Mobile"));
        reject(() -> BrowserProfilePolicy.desktopUa("unknown"));
    }
    @Test public void viewportScriptIsBoundedAndContainsOnlyMeasuredNumericInput() {
        String script=BrowserProfilePolicy.viewportScript(412);
        assertTrue(script.contains("width=412"));
        assertTrue(script.contains("MutationObserver"));
        assertTrue(script.contains("disconnect()"));
        assertTrue(script.contains("3000"));
        reject(() -> BrowserProfilePolicy.viewportScript(-1));
    }
}
