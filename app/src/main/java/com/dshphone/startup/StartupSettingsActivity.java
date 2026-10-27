package com.dshphone.startup;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.provider.OpenableColumns;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import java.io.IOException;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native settings remain accessible when the engine is stopped. */
public final class StartupSettingsActivity extends Activity {
    private static final int VIDEO_PICKER = 26001;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private StartupVideoStore store;
    private StartupVideoStore.Cancel cancellation;
    private TextView status;
    private Button choose, remove, cancel;
    private ProgressBar progress;
    private boolean busy, waitingPicker;
    private volatile boolean destroyed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state); store = StartupPreferences.videos(this);
        waitingPicker = state != null && state.getBoolean("waiting-video-picker", false);
        LinearLayout body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (20 * getResources().getDisplayMetrics().density); body.setPadding(padding, padding, padding, padding);
        ScrollView scroll = new ScrollView(this); scroll.addView(body); setContentView(scroll);
        TextView title = new TextView(this); title.setText("启动页管理"); title.setTextSize(24); body.addView(title);
        TextView intro = new TextView(this); intro.setText("保留原来的自动启动默认行为。下面的开关只影响以后打开应用/开机时是否自动启动引擎，不会停止或重启当前服务。"
                + "\n\n开屏视频默认未选择。只导入你在系统选择器中选的视频（≤50 MiB，不支持 .ts），保存到本应用私有目录。启动时静音播放，可随时跳过；不等待视频结束才启动引擎。\n"); body.addView(intro);
        Switch automatic = new Switch(this); automatic.setText("以后自动启动引擎"); automatic.setChecked(StartupPreferences.autoStart(this)); body.addView(automatic);
        automatic.setOnCheckedChangeListener((button, enabled) -> {
            if (!StartupPreferences.setAutoStart(this, enabled)) { automatic.setChecked(StartupPreferences.autoStart(this)); status.setText("开关保存失败，请重试；当前运行服务未变。"); }
        });
        status = new TextView(this); status.setTextIsSelectable(true); body.addView(status);
        progress = new ProgressBar(this); progress.setVisibility(View.GONE); body.addView(progress);
        choose = button(body, "选择本地开屏视频", this::pick);
        remove = button(body, "移除开屏视频", () -> new AlertDialog.Builder(this).setTitle("移除开屏视频？")
                .setMessage("仅移除本功能保存的本地视频，不影响自动启动开关、会话、账号或当前引擎。")
                .setNegativeButton("取消", null).setPositiveButton("移除", (dialog, which) -> clear()).show());
        cancel = button(body, "取消导入", () -> { if (cancellation != null) cancellation.cancel(); });
        button(body, "返回", this::finish); refresh(); buttons();
    }
    private Button button(LinearLayout body, String label, Runnable action) {
        Button button = new Button(this); button.setText(label); body.addView(button); button.setOnClickListener(v -> action.run()); return button;
    }
    private void refresh() {
        try {
            StartupVideoStore.Info info = store.current();
            status.setText(info == null ? "未选择开屏视频。" : info.name + "\n" + String.format(Locale.ROOT, "%.1f MiB · %.1f 秒 · %d×%d", info.bytes / 1048576.0, info.media.duration / 1000.0, info.media.width, info.media.height));
        } catch (IOException e) { status.setText("旧视频记录暂不可读取；可尝试移除后重新选择，不影响引擎启动。"); }
    }
    private void pick() {
        if (busy || waitingPicker) return;
        waitingPicker = true; buttons(); status.setText("请选择视频；取消不会改变原视频。");
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("video/*")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivityForResult(intent, VIDEO_PICKER); }
        catch (ActivityNotFoundException | SecurityException e) { waitingPicker = false; buttons(); status.setText("没有可用的系统视频选择器；原视频未变。"); }
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != VIDEO_PICKER || destroyed || !waitingPicker) return;
        waitingPicker = false; buttons();
        Uri uri = data == null ? null : data.getData();
        if (resultCode != RESULT_OK || uri == null) { refresh(); return; }
        if (!"content".equals(uri.getScheme())) { status.setText("仅接受系统文档选择器授予的内容文件，不接受远程地址。"); return; }
        begin("正在复制并验证视频；失败或取消保留原视频…", () -> {
            CancellationSignal signal = new CancellationSignal(); cancellation.setHook(signal::cancel);
            try {
                String name = "video"; long declared = -1;
                try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null, signal)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int n = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME), size = cursor.getColumnIndex(OpenableColumns.SIZE);
                        if (n >= 0 && !cursor.isNull(n)) name = cursor.getString(n);
                        if (size >= 0 && !cursor.isNull(size)) declared = cursor.getLong(size);
                    }
                }
                cancellation.check(); String mime = getContentResolver().getType(uri);
                StartupVideoStore.Info result = store.importVideo(name, mime, declared, () -> {
                    AssetFileDescriptor descriptor = getContentResolver().openAssetFileDescriptor(uri, "r", signal);
                    if (descriptor == null) throw new IOException("unreadable");
                    try { return descriptor.createInputStream(); } catch (IOException e) { descriptor.close(); throw e; }
                }, cancellation);
                post(() -> { finishOperation(); refresh(); status.append("\n视频已验证并保存，之后启动时生效；当前引擎未改变。"); });
            } finally { cancellation.setHook(null); }
        });
    }
    private void clear() {
        if (busy || waitingPicker) return;
        begin("正在移除本地开屏视频…", () -> { store.clear(); post(() -> { finishOperation(); refresh(); }); });
    }
    private interface Job { void run() throws Exception; }
    private void begin(String message, Job job) {
        busy = true; cancellation = new StartupVideoStore.Cancel(); progress.setVisibility(View.VISIBLE); status.setText(message); buttons();
        worker.execute(() -> {
            try { job.run(); }
            catch (Exception e) { post(() -> { boolean cancelled = cancellation.isCancelled(); finishOperation(); refresh();
                status.append("\n" + (cancelled ? "已取消，原视频未变。" : messageFor(e.getMessage()))); }); }
        });
    }
    private void finishOperation() { busy = false; progress.setVisibility(View.GONE); buttons(); }
    private void buttons() { choose.setEnabled(!busy && !waitingPicker); remove.setEnabled(!busy && !waitingPicker); cancel.setEnabled(busy); }
    private void post(Runnable job) { runOnUiThread(() -> { if (!destroyed && !isFinishing()) job.run(); }); }
    private static String messageFor(String code) {
        if ("forbidden-ts".equals(code)) return "不支持 MPEG-TS（.ts），原视频未变。";
        if ("too-large".equals(code)) return "视频超过 50 MiB，原视频未变。";
        if ("empty".equals(code)) return "所选文件为空，原视频未变。";
        if ("decode-failed".equals(code)) return "系统无法解码有效的视频画面或时长，原视频未变。";
        if ("size-changed".equals(code)) return "文件读取不完整或大小已变化，原视频未变。";
        if ("superseded".equals(code)) return "视频设置已被其他操作改变，本次导入未覆盖新设置。";
        if ("timeout".equals(code)) return "读取超时，原视频未变。";
        if ("cleanup-incomplete".equals(code)) return "视频配置已移除，部分旧文件未删完，请重试移除。";
        return "保存或读取失败，请重试；未停止或重启引擎。";
    }
    @Override protected void onSaveInstanceState(Bundle outState) { outState.putBoolean("waiting-video-picker", waitingPicker); super.onSaveInstanceState(outState); }
    @Override protected void onDestroy() { destroyed = true; if (cancellation != null) cancellation.cancel(); worker.shutdownNow(); super.onDestroy(); }
}
