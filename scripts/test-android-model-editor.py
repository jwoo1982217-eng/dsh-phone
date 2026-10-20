"""Run the real SDK editor fixture in a disposable Android WebView application."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--adb', default='adb')
    parser.add_argument('--fixture-dir', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    project = args.out / 'project'
    sources = project / 'app/src/main/java/com/dshphone/verification'
    assets = project / 'app/src/main/assets'
    sources.mkdir(parents=True, exist_ok=True)
    assets.mkdir(parents=True, exist_ok=True)
    package = 'com.dshphone.whiteblockverification.t' + uuid.uuid4().hex[:12]
    base = [args.adb, '-s', args.serial]
    for name in ['build.gradle', 'settings.gradle', 'gradle.properties', 'local.properties']:
        if (ROOT / name).exists(): shutil.copy2(ROOT / name, project / name)
    for name in ['fixture.js', 'index.html']:
        shutil.copy2(args.fixture_dir / name, assets / name)
    page = assets / 'index.html'
    page.write_text(page.read_text().replace('src="/fixture.js"', 'src="fixture.js"'))
    (project / 'app/build.gradle').write_text(f"""plugins {{ id 'com.android.application' }}
android {{ namespace 'com.dshphone.verification'; compileSdk 36
 defaultConfig {{ applicationId '{package}'; minSdk 28; targetSdk 36; versionCode 1; versionName 'test' }}
 compileOptions {{ sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }}
}}
""")
    (project / 'app/src/main/AndroidManifest.xml').write_text(f"""<manifest xmlns:android="http://schemas.android.com/apk/res/android">
<application android:label="DSH isolated WebView test" android:allowBackup="false">
<activity android:name="com.dshphone.verification.EditorActivity" android:exported="false" />
</application>
<instrumentation android:name="com.dshphone.verification.EditorInstrumentation" android:targetPackage="{package}" />
</manifest>""")
    (sources / 'EditorInstrumentation.kt').write_text('''package com.dshphone.verification
import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class EditorActivity : Activity() {
    private lateinit var web: WebView
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        web = WebView(this); setContentView(web)
        web.settings.javaScriptEnabled = true
        web.addJavascriptInterface(object {
            @JavascriptInterface fun report(value: String) { EditorInstrumentation.results.offer(value) }
        }, "AndroidFixture")
        var started = false
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                if (started) return; started = true
                view.evaluateJavascript("window.runModelEditorFixture().then(v=>AndroidFixture.report(JSON.stringify(v))).catch(e=>AndroidFixture.report(JSON.stringify({fixtureError:String(e.stack||e)})))", null)
            }
        }
        // Inline under one synthetic origin so Android does not replace the
        // legacy error message with file:// cross-origin "Script error.".
        val script = assets.open("fixture.js").bufferedReader().use { it.readText() }
            .replace("</script", "<" + "\\\\/script")
        val html = assets.open("index.html").bufferedReader().use { it.readText() }
            .replace("<script src=\\"fixture.js\\"></script>", "<script>" + script + "</script>")
        web.loadDataWithBaseURL("https://fixture.invalid/?mode=" + intent.getStringExtra("mode"), html, "text/html", "UTF-8", null)
    }
    override fun onDestroy() { web.destroy(); super.onDestroy() }
}
class EditorInstrumentation : Instrumentation() {
    companion object { val results = LinkedBlockingQueue<String>() }
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        val report = JSONObject().put("cases", JSONArray()).put("productionPackageTouched", false)
        try {
            check(targetContext.packageName.startsWith("com.dshphone.whiteblockverification."))
            for (mode in listOf("legacy", "bundle", "native", "modern")) {
                val activity = startActivitySync(Intent(targetContext, EditorActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("mode", mode))
                try {
                    val raw = results.poll(30, TimeUnit.SECONDS) ?: error("WebView fixture timeout: $mode")
                    val item = JSONObject(raw); report.getJSONArray("cases").put(item)
                    check(!item.has("fixtureError")) { raw }
                    check(item.getBoolean("profileUnchanged") && item.getInt("writes") == 0) { raw }
                    if (mode == "legacy") check(item.getBoolean("blank") && item.getJSONArray("errors").toString().contains("structuredClone")) { raw }
                    else check(item.getBoolean("editorVisible") && item.getBoolean("reopenedEmpty")
                        && item.getBoolean("nativePreserved") && item.getJSONArray("errors").length() == 0) { raw }
                    sendStatus(0, Bundle().apply { putString("stream", "PASS: Android WebView $mode model editor\\n") })
                } finally { runOnMainSync { activity.finish() }; waitForIdleSync() }
            }
            report.put("webView", WebView.getCurrentWebViewPackage()?.versionName).put("passed", true)
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "DSH_EDITOR_TESTS_OK\\n" + report.toString() + "\\n") })
        } catch (e: Throwable) {
            report.put("passed", false).put("error", e.toString())
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("stream", "DSH_EDITOR_TESTS_FAILED\\n" + report.toString() + "\\n") })
        }
    }
}
''')
    with (args.out / 'build.log').open('w') as log:
        subprocess.run([str(ROOT / 'gradlew'), '--offline', ':app:assembleDebug'], cwd=project, stdout=log, stderr=subprocess.STDOUT, check=True)
    receipt = {'package': package, 'productionPackageTouched': False}
    receipt['productionPidBefore'] = subprocess.run([*base, 'shell', 'pidof', 'com.dshphone'], capture_output=True, text=True).stdout.strip()
    installed = False
    try:
        subprocess.run([*base, 'install', str(project / 'app/build/outputs/apk/debug/app-debug.apk')], capture_output=True, check=True)
        installed = True
        run = subprocess.run([*base, 'shell', 'am', 'instrument', '-w', '-r', package + '/com.dshphone.verification.EditorInstrumentation'], capture_output=True, text=True, timeout=150, check=True)
        (args.out / 'instrumentation.log').write_text(run.stdout + run.stderr)
        lines = run.stdout.splitlines()
        report = next((line for line in lines if line.startswith('{') and '"cases"' in line), None)
        if report: receipt.update(json.loads(report))
        receipt['passed'] = receipt.get('passed', False) and 'DSH_EDITOR_TESTS_OK' in run.stdout and 'INSTRUMENTATION_CODE: -1' in run.stdout
        if not receipt['passed']: raise RuntimeError('Android WebView editor test failed; see instrumentation.log')
    finally:
        if installed:
            removed = subprocess.run([*base, 'uninstall', package], capture_output=True, text=True, check=True)
            receipt['temporaryApplicationRemoved'] = 'Success' in removed.stdout
        receipt['productionPidAfter'] = subprocess.run([*base, 'shell', 'pidof', 'com.dshphone'], capture_output=True, text=True).stdout.strip()
        (args.out / 'verification.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt))

if __name__ == '__main__':
    main()
