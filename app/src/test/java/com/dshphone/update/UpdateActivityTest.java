package com.dshphone.update;

import static org.junit.Assert.*;
import android.content.Context;
import android.net.Uri;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import androidx.core.content.FileProvider;
import java.io.File;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class UpdateActivityTest {
    @Test public void enteringAndResumingUpdaterDoesNotCheckDownloadOrInstall() {
        try (ActivityController<UpdateActivity> controller = Robolectric.buildActivity(UpdateActivity.class).setup()) {
            UpdateActivity activity = controller.get();
            assertTrue(find(activity.getWindow().getDecorView(), "检查已发布的增强版").isEnabled());
            assertFalse(find(activity.getWindow().getDecorView(), "下载并校验").isEnabled());
            assertFalse(find(activity.getWindow().getDecorView(), "安装已验证的更新").isEnabled());
            assertFalse(find(activity.getWindow().getDecorView(), "取消当前操作").isEnabled());
            controller.pause().resume();
            assertFalse(find(activity.getWindow().getDecorView(), "安装已验证的更新").isEnabled());
            assertNull(Shadows.shadowOf(activity).getNextStartedActivity());
        }
    }
    @Test public void providerExposesOnlyVerifiedCacheNeverPendingOrUserFiles() throws Exception {
        Context context = RuntimeEnvironment.getApplication(); String authority = context.getPackageName() + ".phone.updates";
        File verified = new File(context.getCacheDir(), "phone-updates/verified/fixture.apk");
        verified.getParentFile().mkdirs(); verified.createNewFile();
        try {
            Uri uri = FileProvider.getUriForFile(context, authority, verified); assertEquals("content", uri.getScheme());
            assertEquals(authority, uri.getAuthority());
            for (File forbidden : new File[]{new File(context.getCacheDir(), "phone-updates/pending/fixture.part"),
                    new File(context.getCacheDir(), "other.apk"), new File(context.getFilesDir(), "accounts.json")}) {
                try { FileProvider.getUriForFile(context, authority, forbidden); fail("Provider must not expose " + forbidden); }
                catch (IllegalArgumentException expected) { }
            }
        } finally { verified.delete(); }
    }
    private static Button find(View root, String text) {
        if (root instanceof Button && text.contentEquals(((Button) root).getText())) return (Button) root;
        if (root instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) root).getChildCount(); i++) {
            Button match = find(((ViewGroup) root).getChildAt(i), text); if (match != null) return match;
        }
        return null;
    }
}
