package com.dshphone.startup;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Application;
import android.content.Intent;
import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.Switch;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowMediaMetadataRetriever;
import org.robolectric.shadows.util.DataSource;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class StartupNativeTest {
    private Application app;
    @Before public void setup() throws Exception {
        app = RuntimeEnvironment.getApplication();
        app.getSharedPreferences("phone_startup_preferences", 0).edit().clear().commit();
        StartupPreferences.videos(app).clear();
    }
    @Test public void defaultsPreserveAutoStartAndHaveNoVideo() throws Exception {
        assertTrue(StartupPreferences.autoStart(app)); assertNull(StartupPreferences.videos(app).current());
        assertNull(Shadows.shadowOf(app).getNextStartedService());
    }
    @Test public void settingFutureAutoStartNeverTouchesCurrentEngine() {
        assertTrue(StartupPreferences.setAutoStart(app, false)); assertFalse(StartupPreferences.autoStart(app));
        assertNull(Shadows.shadowOf(app).getNextStartedService());
        assertTrue(StartupPreferences.setAutoStart(app, true)); assertTrue(StartupPreferences.autoStart(app));
        assertNull(Shadows.shadowOf(app).getNextStartedService());
    }
    @Test public void nativeSettingsUsesSystemContentPickerWithoutStoragePermission() {
        try (ActivityController<StartupSettingsActivity> controller = Robolectric.buildActivity(StartupSettingsActivity.class).setup()) {
            StartupSettingsActivity activity = controller.get();
            Switch toggle = findSwitch(activity.getWindow().getDecorView()); assertNotNull(toggle); assertTrue(toggle.isChecked());
            toggle.setChecked(false); assertFalse(StartupPreferences.autoStart(app));
            findButton(activity.getWindow().getDecorView(), "选择本地开屏视频").performClick();
            Intent picker = Shadows.shadowOf(activity).getNextStartedActivity(); assertNotNull(picker);
            assertEquals(Intent.ACTION_OPEN_DOCUMENT, picker.getAction()); assertEquals("video/*", picker.getType());
            assertTrue(picker.hasCategory(Intent.CATEGORY_OPENABLE)); assertNull(picker.getData());
            assertEquals(0, picker.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            assertNull(Shadows.shadowOf(app).getNextStartedService());
            activity.onActivityResult(26001, Activity.RESULT_CANCELED, null);
            assertTrue(findButton(activity.getWindow().getDecorView(), "选择本地开屏视频").isEnabled());
        }
    }
    @Test public void remotePickerUrlsAreRejectedWithoutStartingImport() throws Exception {
        try (ActivityController<StartupSettingsActivity> controller = Robolectric.buildActivity(StartupSettingsActivity.class).setup()) {
            StartupSettingsActivity activity = controller.get(); findButton(activity.getWindow().getDecorView(), "选择本地开屏视频").performClick();
            activity.onActivityResult(26001, Activity.RESULT_OK, new Intent().setData(Uri.parse("https://example.test/video.mp4")));
            assertNull(StartupPreferences.videos(app).current());
            assertFalse(findButton(activity.getWindow().getDecorView(), "取消导入").isEnabled());
        }
    }
    @Test public void noConfiguredVideoLeavesContainerUntouched() {
        try (ActivityController<Activity> controller = Robolectric.buildActivity(Activity.class).setup()) {
            FrameLayout host = new FrameLayout(controller.get()); controller.get().setContentView(host);
            assertNull(StartupSplash.show(controller.get(), host)); assertEquals(0, host.getChildCount());
        }
    }
    @Test public void overlaySkipTimeoutAndDestroyAreNonBlockingAndIdempotent() throws Exception {
        installFixtureVideo();
        try (ActivityController<Activity> controller = Robolectric.buildActivity(Activity.class).setup()) {
            Activity activity = controller.get(); FrameLayout host = new FrameLayout(activity); activity.setContentView(host);
            StartupSplash splash = StartupSplash.show(activity, host); assertNotNull(splash); assertTrue(splash.isActive()); assertEquals(1, host.getChildCount());
            findButton(host, "跳过开屏视频").performClick(); assertFalse(splash.isActive()); assertEquals(0, host.getChildCount()); splash.close();
            StartupSplash timed = StartupSplash.show(activity, host); assertNotNull(timed);
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(31)); assertFalse(timed.isActive()); assertEquals(0, host.getChildCount());
            StartupSplash destroyed = StartupSplash.show(activity, host); assertNotNull(destroyed);
            controller.pause().stop().destroy(); assertFalse(destroyed.isActive()); assertEquals(0, host.getChildCount());
            assertNull(Shadows.shadowOf(app).getNextStartedService());
        }
    }
    @Test public void mediaProbeRequiresVideoMetadataAndADecodablePreviewFrame() throws Exception {
        File fixture = File.createTempFile("startup-media-fixture-", ".mp4");
        try {
            metadata(fixture, true, "video/mp4", "1500");
            try { new AndroidVideoProbe().inspect(fixture); fail("Metadata without a video frame must not be accepted"); }
            catch (IOException expected) { assertEquals("decode-failed", expected.getMessage()); }
            Bitmap preview = Bitmap.createBitmap(16,16,Bitmap.Config.ARGB_8888);
            ShadowMediaMetadataRetriever.addScaledFrame(DataSource.toDataSource(fixture.getAbsolutePath()), 0, 320, 320, preview);
            StartupVideoStore.Media valid = new AndroidVideoProbe().inspect(fixture); assertEquals(1500, valid.duration); assertTrue(preview.isRecycled());
            metadata(fixture, false, "audio/mp4", "1500");
            try { new AndroidVideoProbe().inspect(fixture); fail(); } catch (IOException expected) { assertEquals("decode-failed", expected.getMessage()); }
        } finally { fixture.delete(); }
    }
    @Test public void mediaProbeRejectsDisguisedTsAndInvalidDuration() throws Exception {
        File fixture = File.createTempFile("startup-media-fixture-", ".mp4");
        try {
            metadata(fixture, true, "video/mp2t", "1500");
            try { new AndroidVideoProbe().inspect(fixture); fail(); } catch (IOException expected) { assertEquals("forbidden-ts", expected.getMessage()); }
            metadata(fixture, true, "video/mp4", "0");
            try { new AndroidVideoProbe().inspect(fixture); fail(); } catch (IOException expected) { assertEquals("decode-failed", expected.getMessage()); }
        } finally { fixture.delete(); }
    }
    private void installFixtureVideo() throws Exception {
        StartupVideoStore fixture = new StartupVideoStore(new File(app.getFilesDir(), "startup-videos"), file -> new StartupVideoStore.Media(true,1000,320,180,"video/mp4"));
        fixture.importVideo("fixture.mp4","video/mp4",-1,()->new ByteArrayInputStream("synthetic-video".getBytes(StandardCharsets.UTF_8)),new StartupVideoStore.Cancel());
    }
    private void metadata(File file,boolean video,String mime,String duration) {
        ShadowMediaMetadataRetriever.addMetadata(file.getAbsolutePath(),MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO,video?"yes":"no");
        ShadowMediaMetadataRetriever.addMetadata(file.getAbsolutePath(),MediaMetadataRetriever.METADATA_KEY_DURATION,duration);
        ShadowMediaMetadataRetriever.addMetadata(file.getAbsolutePath(),MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH,"320");
        ShadowMediaMetadataRetriever.addMetadata(file.getAbsolutePath(),MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT,"180");
        ShadowMediaMetadataRetriever.addMetadata(file.getAbsolutePath(),MediaMetadataRetriever.METADATA_KEY_MIMETYPE,mime);
    }
    private static Button findButton(View root,String label) {
        if(root instanceof Button && label.contentEquals(((Button)root).getText()))return (Button)root;
        if(root instanceof ViewGroup)for(int i=0;i<((ViewGroup)root).getChildCount();i++){Button found=findButton(((ViewGroup)root).getChildAt(i),label);if(found!=null)return found;}return null;
    }
    private static Switch findSwitch(View root) {
        if(root instanceof Switch)return (Switch)root;
        if(root instanceof ViewGroup)for(int i=0;i<((ViewGroup)root).getChildCount();i++){Switch found=findSwitch(((ViewGroup)root).getChildAt(i));if(found!=null)return found;}return null;
    }
}
