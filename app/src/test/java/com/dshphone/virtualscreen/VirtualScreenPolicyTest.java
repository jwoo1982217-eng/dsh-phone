package com.dshphone.virtualscreen;
import org.junit.Test;
import static org.junit.Assert.*;

public class VirtualScreenPolicyTest {
    private void reject(Runnable action) {
        try { action.run(); fail("Expected rejection"); } catch (IllegalArgumentException expected) { }
    }
    @Test public void neverAliasesTheRealScreen() {
        reject(() -> VirtualScreenPolicy.requireOwned("real", 2));
        reject(() -> VirtualScreenPolicy.requireOwned("virtual-1", 0));
        reject(() -> VirtualScreenPolicy.requireOwned("virtual-2", 2));
        VirtualScreenPolicy.requireOwned("virtual-1", 2);
    }
    @Test public void fixedArgvAlwaysIncludesThePositiveDisplay() {
        assertArrayEquals(new String[]{"/system/bin/input","-d","3","tap","10","20"}, VirtualScreenPolicy.tap(3, 480,800,10,20));
        assertArrayEquals(new String[]{"/system/bin/input","-d","3","keyevent","4"}, VirtualScreenPolicy.back(3));
        reject(() -> VirtualScreenPolicy.tap(0,480,800,1,1));
    }
    @Test public void coordinatesMustBeFiniteAndInsideThisDisplay() {
        for (double x : new double[]{-1,480,Double.NaN,Double.POSITIVE_INFINITY}) reject(() -> VirtualScreenPolicy.tap(3,480,800,x,20));
        reject(() -> VirtualScreenPolicy.tap(3,480,800,10,800));
    }
    @Test public void componentsCannotInjectAnotherCommandOrChangePackage() {
        assertArrayEquals(new String[]{"/system/bin/am","start","--user","0","--display","4","-n","com.example/.MainActivity"}, VirtualScreenPolicy.launch(4,0,"com.example","com.example/.MainActivity"));
        for (String component : new String[]{"com.other/.Main", "com.example/.Main;id", "com.example/.Main\n", "com.example/--display 0"}) reject(() -> VirtualScreenPolicy.launch(4,0,"com.example",component));
        reject(() -> VirtualScreenPolicy.resolveActivity(0,"com.example;id"));
    }
    @Test public void letterboxMappingRejectsBlackBarsAndPreservesAspect() {
        // Portrait content fitted to a landscape surface: only x=400..700 is content.
        assertArrayEquals(new int[]{400,0,300,500},VirtualScreenPolicy.fit(1100,500,480,800));
        assertArrayEquals(new int[]{240,400},VirtualScreenPolicy.point(550,250,1100,500,480,800));
        reject(() -> VirtualScreenPolicy.point(399,250,1100,500,480,800));
        reject(() -> VirtualScreenPolicy.point(700,250,1100,500,480,800));
        reject(() -> VirtualScreenPolicy.fit(0,500,480,800));
    }
    @Test public void targetOnlySnapshotsAreFreshAndSingleUse() {
        VirtualScreenPolicy.Snapshot snapshot = new VirtualScreenPolicy.Snapshot("session-a","nonce",3,480,800,10,1000);
        assertTrue(snapshot.matches("session-a","nonce",3,10,1100));
        assertFalse(snapshot.matches("session-b","nonce",3,10,1100));
        assertFalse(snapshot.matches("session-a","nonce",0,10,1100));
        assertFalse(snapshot.matches("session-a","nonce",3,11,1100));
        assertFalse(snapshot.matches("session-a","nonce",3,10,31000));
        assertFalse(snapshot.matches("session-a","nonce",3,10,999));
    }
}
