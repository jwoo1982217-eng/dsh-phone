package com.dshphone.startup;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.File;

/** Settings affect future entry/start decisions only; no service or engine calls live here. */
public final class StartupPreferences {
    private static final String PREFS = "phone_startup_preferences";
    private static final String AUTO_START = "automatically_start_engine";
    public static boolean autoStart(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return StartupPolicy.autoStart(prefs.contains(AUTO_START) ? prefs.getBoolean(AUTO_START, true) : null);
    }
    public static boolean setAutoStart(Context context, boolean enabled) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(AUTO_START, enabled).commit();
    }
    public static StartupVideoStore videos(Context context) {
        return new StartupVideoStore(new File(context.getApplicationContext().getFilesDir(), "startup-videos"), new AndroidVideoProbe());
    }
    private StartupPreferences() { }
}
