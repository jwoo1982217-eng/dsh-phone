package com.dshphone.update;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.IOException;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** User initiated APK updates only; neither app startup nor onResume performs network I/O. */
public final class UpdateActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final PhoneUpdateClient client = new PhoneUpdateClient();
    private PhoneUpdateClient.Cancel cancellation;
    private PhoneUpdateClient.Release release;
    private AndroidApkVerifier.Verified ready;
    private TextView status;
    private Button check, download, install, cancel;
    private ProgressBar progress;
    private boolean busy;
    private volatile boolean destroyed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (20 * getResources().getDisplayMetrics().density); content.setPadding(padding, padding, padding, padding);
        ScrollView scroll = new ScrollView(this); scroll.addView(content); setContentView(scroll);
        TextView title = new TextView(this); title.setText("增强版在线更新"); title.setTextSize(24); content.addView(title);
        TextView explanation = new TextView(this);
        explanation.setText("当前版本：" + installedVersion() + "\n更新来源：" + UpdateArtifactPolicy.REPOSITORY
                + "\n\n仅在你点击后检查或下载，不后台检查。只接受相同包名、相同签名、更高 versionCode 的 arm64-v8a 安装包。"
                + "安装仍需 Android 系统确认；不会下载官方不同包名的 APK，也不会清除会话或配置。\n");
        content.addView(explanation);
        status = new TextView(this); status.setTextIsSelectable(true);
        status.setText("尚未检查。源码已同步不等于 APK 已发布；若仓库尚无正式发行包，会明确提示。"); content.addView(status);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100); progress.setVisibility(View.GONE); content.addView(progress);
        check = button(content, "检查已发布的增强版", this::checkLatest);
        download = button(content, "下载并校验", this::download); download.setEnabled(false);
        install = button(content, "安装已验证的更新", this::confirmInstall); install.setEnabled(false);
        cancel = button(content, "取消当前操作", () -> { if (cancellation != null) cancellation.cancel(); }); cancel.setEnabled(false);
        button(content, "返回", this::finish);
    }

    private Button button(LinearLayout parent, String label, Runnable action) {
        Button button = new Button(this); button.setText(label); parent.addView(button);
        button.setOnClickListener(view -> action.run()); return button;
    }

    private String installedVersion() {
        try { PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName + " / " + info.getLongVersionCode();
        } catch (PackageManager.NameNotFoundException e) { return "身份暂不可读取（不会允许安装）"; }
    }

    private void checkLatest() {
        if (busy) return;
        release = null; ready = null;
        start("正在检查本增强版 GitHub 正式发行包…", () -> {
            PhoneUpdateClient.Release found = client.checkLatest(cancellation);
            post(() -> {
                release = found;
                if (found == null) status.setText("本增强版仓库尚未发布正式 APK 更新。当前源码同步不代表已有安装包；没有下载或安装任何内容。");
                else { status.setText("已发布：" + found.tag + "\n" + found.name + "\n大小：" + found.size
                        + " 字节\n下载后将核对真实 versionCode、包名、签名和 SHA256，尚未确认是可安装的新版本。"); }
                finishOperation();
            });
        });
    }

    private void download() {
        if (busy || release == null) return;
        if (!Arrays.asList(Build.SUPPORTED_ABIS).contains("arm64-v8a")) {
            status.setText("当前设备不支持本增强版的 arm64-v8a 安装包。"); return;
        }
        PhoneUpdateClient.Release selected = release; ready = null;
        start("正在下载到应用私有缓存，其他应用无法读取未验证文件…", () -> {
            File pendingDir = new File(getCacheDir(), "phone-updates/pending");
            File verifiedDir = new File(getCacheDir(), "phone-updates/verified");
            if ((!pendingDir.isDirectory() && !pendingDir.mkdirs()) || (!verifiedDir.isDirectory() && !verifiedDir.mkdirs()))
                throw new IOException("无法建立私有更新缓存");
            File pending = File.createTempFile("download-", ".part", pendingDir);
            File promoted = null; boolean success = false;
            try {
                final int[] lastPercent = {-1};
                String digest = client.download(selected, pending, cancellation, (bytes, expected) -> {
                    int percent = (int) (bytes * 100 / expected);
                    if (percent != lastPercent[0]) { lastPercent[0] = percent; post(() -> progress.setProgress(percent)); }
                });
                post(() -> status.setText("下载完成，正在校验 ZIP、SHA256、包名、versionCode 和当前安装签名…"));
                AndroidApkVerifier.Verified verified = AndroidApkVerifier.verify(this, pending, selected, digest, cancellation);
                promoted = File.createTempFile("verified-", ".apk", verifiedDir);
                if (!promoted.delete() || !pending.renameTo(promoted)) throw new IOException("无法保存已验证安装包");
                if (!promoted.setReadOnly()) throw new IOException("无法锁定已验证安装包");
                cancellation.check();
                AndroidApkVerifier.Verified value = new AndroidApkVerifier.Verified(promoted, selected, digest, verified.versionName, verified.versionCode);
                success = true;
                post(() -> { ready = value;
                    status.setText("已验证：" + value.versionName + " / " + value.versionCode + "\n包名与签名均与当前应用相同。\nSHA256："
                            + value.sha256 + "\n尚未安装。点击安装后仍需原生确认和 Android 安装确认。"); finishOperation(); });
            } finally {
                if (pending.exists()) pending.delete();
                if (!success && promoted != null) promoted.delete();
            }
        });
    }

    private void confirmInstall() {
        if (busy || ready == null) return;
        AndroidApkVerifier.Verified selected = ready;
        start("正在再次核对缓存、当前版本和签名…", () -> {
            AndroidApkVerifier.Verified verified = AndroidApkVerifier.verify(this, selected.file, selected.release, selected.sha256, cancellation);
            post(() -> { finishOperation();
                new AlertDialog.Builder(this).setTitle("安装已验证的增强版？")
                        .setMessage("版本：" + verified.versionName + " / " + verified.versionCode
                                + "\n包名：" + getPackageName() + "\n签名：与当前安装相同\n\n"
                                + "仅进行覆盖升级，不卸载、不清除资料。下一步由 Android 系统安装器确认；应用不会静默安装。")
                        .setNegativeButton("取消", null).setPositiveButton("交给系统安装器", (dialog, which) -> handOff(verified)).show();
            });
        });
    }

    private void handOff(AndroidApkVerifier.Verified verified) {
        if (!getPackageManager().canRequestPackageInstalls()) {
            status.setText("尚未允许本应用请求安装更新。请在系统页面自行允许后返回，再点击“安装已验证的更新”；不会自动续装。");
            try { startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName()))); }
            catch (ActivityNotFoundException e) { status.setText("设备没有安装来源授权页面，未启动安装。可稍后手动重试。"); }
            return;
        }
        try {
            File allowed = new File(getCacheDir(), "phone-updates/verified").getCanonicalFile();
            File actual = verified.file.getCanonicalFile();
            if (!actual.getParentFile().equals(allowed) || !actual.isFile() || actual.length() != verified.release.size)
                throw new IOException("已验证缓存已变化，请重新下载");
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".phone.updates", actual);
            Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE).setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(ClipData.newRawUri("verified-update", uri));
            startActivity(intent);
            status.setText("已交给 Android 系统安装器，尚不能认定安装完成。取消系统安装不会修改本应用资料。");
        } catch (IOException | IllegalArgumentException | ActivityNotFoundException | SecurityException e) {
            status.setText("未启动安装：" + safeMessage(e));
        }
    }

    private interface Job { void run() throws Exception; }
    private void start(String message, Job job) {
        busy = true; cancellation = new PhoneUpdateClient.Cancel(); status.setText(message);
        progress.setProgress(0); progress.setVisibility(View.VISIBLE); updateButtons();
        worker.execute(() -> {
            try { job.run(); }
            catch (Exception error) { post(() -> { ready = null;
                status.setText(cancellation.isCancelled() ? "操作已取消，未启动安装。" : "操作未完成：" + safeMessage(error)); finishOperation(); }); }
        });
    }
    private void finishOperation() { busy = false; progress.setVisibility(View.GONE); updateButtons(); }
    private void updateButtons() {
        check.setEnabled(!busy); download.setEnabled(!busy && release != null);
        install.setEnabled(!busy && ready != null); cancel.setEnabled(busy);
    }
    private void post(Runnable action) { runOnUiThread(() -> { if (!destroyed && !isFinishing()) action.run(); }); }
    private static String safeMessage(Throwable error) {
        String message = error.getMessage(); if (message == null || message.trim().isEmpty()) message = error.getClass().getSimpleName();
        return message.length() > 400 ? message.substring(0, 400) : message;
    }
    @Override protected void onDestroy() {
        destroyed = true; if (cancellation != null) cancellation.cancel(); worker.shutdownNow(); super.onDestroy();
    }
}
