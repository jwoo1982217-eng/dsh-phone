package com.dshphone.startup;

import android.app.Activity;
import android.app.Application;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.media.MediaPlayer;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import java.io.IOException;

/**
 * Adapted from SplashOverlay in kelai141/dsh-mobile-apk (MIT, 1a8f9fb).
 * Copyright (c) 2026 kelai141. Full MIT notice: assets/licenses/dsh-mobile-apk-MIT.txt.
 * Pure decoration: showing/closing this overlay never gates or starts/stops the engine.
 */
public final class StartupSplash implements AutoCloseable {
    private final Activity activity;
    private final ViewGroup container;
    private final FrameLayout layer;
    private final TextureView texture;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable timeout = this::close;
    private final Application.ActivityLifecycleCallbacks lifecycle;
    private MediaPlayer player;
    private Surface surface;
    private boolean closed, prepared, paused;

    /** Returns immediately; null means no validated private video is configured. Main-thread only. */
    public static StartupSplash show(Activity activity, ViewGroup container) {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("StartupSplash.show must run on main thread");
        if (activity.isFinishing() || activity.isDestroyed()) return null;
        try {
            StartupVideoStore.Info info = StartupPreferences.videos(activity).current();
            return info == null ? null : new StartupSplash(activity, container, info.file.getAbsolutePath());
        } catch (IOException | RuntimeException e) { return null; }
    }

    private StartupSplash(Activity activity, ViewGroup container, String localPath) {
        this.activity = activity; this.container = container;
        layer = new FrameLayout(activity); layer.setBackgroundColor(Color.BLACK);
        layer.setContentDescription("本地开屏视频，可跳过"); layer.setClickable(true);
        texture = new TextureView(activity); texture.setOpaque(true);
        texture.setImportantForAccessibility(android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        layer.addView(texture, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        Button skip = new Button(activity); skip.setText("跳过开屏视频"); skip.setOnClickListener(view -> close());
        int margin = (int) (16 * activity.getResources().getDisplayMetrics().density);
        FrameLayout.LayoutParams button = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
        button.setMargins(margin, margin, margin, margin); layer.addView(skip, button);
        texture.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            public void onSurfaceTextureAvailable(SurfaceTexture surfaceTexture, int width, int height) { start(localPath, surfaceTexture); }
            public void onSurfaceTextureSizeChanged(SurfaceTexture surfaceTexture, int width, int height) { cover(); }
            public boolean onSurfaceTextureDestroyed(SurfaceTexture surfaceTexture) { close(); return true; }
            public void onSurfaceTextureUpdated(SurfaceTexture surfaceTexture) { }
        });
        lifecycle = new Application.ActivityLifecycleCallbacks() {
            public void onActivityCreated(Activity a, Bundle b) { }
            public void onActivityStarted(Activity a) { }
            public void onActivityResumed(Activity a) { if (a == activity) resume(); }
            public void onActivityPaused(Activity a) { if (a == activity) pause(); }
            public void onActivityStopped(Activity a) { }
            public void onActivitySaveInstanceState(Activity a, Bundle b) { }
            public void onActivityDestroyed(Activity a) { if (a == activity) close(); }
        };
        activity.getApplication().registerActivityLifecycleCallbacks(lifecycle);
        container.addView(layer, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        layer.bringToFront(); handler.postDelayed(timeout, StartupPolicy.SPLASH_TIMEOUT_MILLIS);
    }

    private void start(String localPath, SurfaceTexture surfaceTexture) {
        if (closed || player != null) return;
        try {
            MediaPlayer media = new MediaPlayer(); player = media;
            surface = new Surface(surfaceTexture); media.setSurface(surface);
            media.setDataSource(localPath); media.setVolume(0f, 0f); media.setLooping(false);
            media.setOnErrorListener((ignored, what, extra) -> { close(); return true; });
            media.setOnCompletionListener(ignored -> close());
            media.setOnVideoSizeChangedListener((ignored, width, height) -> cover());
            media.setOnPreparedListener(ready -> {
                if (closed) return;
                prepared = true; cover(); if (!paused) ready.start();
            });
            media.prepareAsync();
        } catch (IOException | RuntimeException e) { close(); }
    }
    private void cover() {
        MediaPlayer media = player; if (media == null || !prepared || closed) return;
        try {
            int width = media.getVideoWidth(), height = media.getVideoHeight();
            if (width <= 0 || height <= 0 || texture.getWidth() <= 0 || texture.getHeight() <= 0) return;
            float viewWidth = texture.getWidth(), viewHeight = texture.getHeight();
            float scale = Math.max(viewWidth / width, viewHeight / height);
            Matrix matrix = new Matrix();
            // TextureView maps its surface to view dimensions before this matrix is applied.
            matrix.setScale(width * scale / viewWidth, height * scale / viewHeight, viewWidth / 2f, viewHeight / 2f);
            texture.setTransform(matrix);
        } catch (RuntimeException e) { close(); }
    }
    public void pause() {
        paused = true;
        try { if (prepared && player != null && player.isPlaying()) player.pause(); }
        catch (RuntimeException e) { close(); }
    }
    public void resume() {
        paused = false;
        try { if (!closed && prepared && player != null && !player.isPlaying()) player.start(); }
        catch (RuntimeException e) { close(); }
    }
    public boolean isActive() { return !closed; }
    @Override public void close() {
        if (Looper.myLooper() != Looper.getMainLooper()) { handler.post(this::close); return; }
        if (closed) return; closed = true; handler.removeCallbacks(timeout);
        activity.getApplication().unregisterActivityLifecycleCallbacks(lifecycle);
        texture.setSurfaceTextureListener(null);
        MediaPlayer media = player; player = null; prepared = false;
        if (media != null) {
            try { media.setOnPreparedListener(null); media.setOnErrorListener(null); media.setOnCompletionListener(null); media.setOnVideoSizeChangedListener(null); media.reset(); }
            catch (RuntimeException ignored) { }
            try { media.release(); } catch (RuntimeException ignored) { }
        }
        if (surface != null) { surface.release(); surface = null; }
        container.removeView(layer);
    }
}
