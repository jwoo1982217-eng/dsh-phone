"""Verify unchanged viewport retention and rollback in one disposable Android UID."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = re.compile(r"com\.dshphone\.browserretentionverification\.t[a-f0-9]{32}\Z")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--output", required=True)
    parser.add_argument("--project", required=True, help="Reuse this task's small generated Gradle project")
    parser.add_argument("--before-service", required=True)
    args = parser.parse_args()
    output, project = Path(args.output).resolve(), Path(args.project).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output / "verification.json").exists():
        raise ValueError("A device receipt already exists; inspect it instead of overwriting")
    package = "com.dshphone.browserretentionverification.t" + uuid.uuid4().hex
    assert PACKAGE.fullmatch(package)
    base = [args.adb, "-s", args.serial]
    trace = []

    def adb(*command, check=True):
        value = subprocess.run([*base, *command], capture_output=True, text=True, timeout=120)
        trace.append({"args": list(command), "exit": value.returncode, "stdout": value.stdout[-3000:], "stderr": value.stderr[-1000:]})
        if check:
            value.check_returncode()
        return value

    assert adb("get-state").stdout.strip() == "device"
    existing = adb("shell", "pm", "path", package, check=False)
    assert existing.returncode in (0, 1) and not existing.stdout.strip(), "Refuse an existing package"
    sources = project / "app/src/main/java/com/dshphone/browser"
    sources.mkdir(parents=True, exist_ok=True)
    for name in ("build.gradle", "settings.gradle", "gradle.properties", "local.properties"):
        shutil.copy2(ROOT / name, project / name)
    for name in ("BrowserProfilePolicy.java", "BrowserActivity.kt", "BrowserClient.kt"):
        shutil.copy2(ROOT / "app/src/main/java/com/dshphone/browser" / name, sources / name)
    before = Path(args.before_service).resolve().read_bytes()
    after = (ROOT / "app/src/main/java/com/dshphone/browser/BrowserService.kt").read_bytes()
    if before == after:
        raise ValueError("The old/new services must differ for a genuine upgrade comparison")
    instrument = project / "app/src/main/java/com/dshphone/BrowserRetentionInstrumentation.kt"
    shutil.copy2(ROOT / "scripts/android-browser-retention-test/BrowserRetentionInstrumentation.kt", instrument)
    assets = project / "app/src/main/assets"
    assets.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "app/src/main/assets/dsh-browser-dom.js", assets / "dsh-browser-dom.js")
    (project / "app/src/main/AndroidManifest.xml").write_text(
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">'
        '<uses-permission android:name="android.permission.INTERNET"/>'
        '<application android:testOnly="true" android:allowBackup="false" android:usesCleartextTraffic="true">'
        '<service android:name="com.dshphone.browser.BrowserService" android:exported="false"/></application>'
        f'<instrumentation android:name="com.dshphone.BrowserRetentionInstrumentation" android:targetPackage="{package}"/>'
        '</manifest>')
    original_path = adb("shell", "pm", "path", "com.dshphone").stdout.strip()
    original_info = adb("shell", "dumpsys", "package", "com.dshphone").stdout
    identity = [line.strip() for line in original_info.splitlines() if any(k in line for k in ("versionCode=", "versionName=", "lastUpdateTime=", "firstInstallTime="))]
    result = {"package": package, "serial": args.serial, "productionPackageTouched": False,
              "beforeServiceSha": hashlib.sha256(before).hexdigest(), "afterServiceSha": hashlib.sha256(after).hexdigest(), "phases": [], "commands": trace}
    env = os.environ.copy()
    if not env.get("JAVA_HOME"):
        env["JAVA_HOME"] = "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    attempted_install = False
    try:
        for version, phase, contents, expected in ((1, "before", before, False), (2, "after", after, True),
                                                   (3, "rollback", before, False), (4, "reapply", after, True)):
            (sources / "BrowserService.kt").write_bytes(contents)
            (project / "app/build.gradle").write_text(f"""plugins {{ id 'com.android.application' }}
android {{namespace 'com.dshphone';compileSdk 36
 defaultConfig {{applicationId '{package}';minSdk 28;targetSdk 36;versionCode {version};versionName '{phase}'}}
 compileOptions {{sourceCompatibility JavaVersion.VERSION_17;targetCompatibility JavaVersion.VERSION_17}}
 testOptions {{unitTests {{includeAndroidResources=true}}}}
}}
dependencies {{implementation 'androidx.core:core:1.17.0';implementation 'androidx.webkit:webkit:1.12.1';testImplementation 'junit:junit:4.13.2';testImplementation 'org.robolectric:robolectric:4.16'}}
""")
            with (output / (phase + "-build.log")).open("w") as log:
                subprocess.run([str(ROOT / "gradlew"), "--offline", "--no-daemon", "--max-workers=2", "--no-parallel", ":app:assembleDebug"],
                               cwd=project, env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=300)
            apk = project / "app/build/outputs/apk/debug/app-debug.apk"
            aapt = Path.home() / "Library/Android/sdk/build-tools/36.0.0/aapt"
            badging = subprocess.check_output([str(aapt), "dump", "badging", str(apk)], text=True)
            if not re.search(r"^package: name='" + re.escape(package) + r"' versionCode='" + str(version) + r"'", badging, re.M):
                raise ValueError("Refuse an APK outside the disposable package/version")
            attempted_install = True
            adb("install", "-t", "-r", str(apk))
            uid = adb("shell", "pm", "list", "packages", "-U", package).stdout.strip()
            assert re.fullmatch(r"package:" + re.escape(package) + r" uid:\d+", uid)
            if result["phases"]:
                assert uid == result["phases"][0]["uid"], "Fixture UID changed across upgrade"
            run = adb("shell", "am", "instrument", "-w", "-r", "-e", "phase", phase, "-e", "expected", str(expected).lower(),
                      package + "/com.dshphone.BrowserRetentionInstrumentation")
            (output / (phase + "-device.log")).write_text(run.stdout + run.stderr)
            match = re.search(r"DSH_BROWSER_RETENTION_OK (\{[^\n]+\})", run.stdout)
            assert match and "INSTRUMENTATION_CODE: -1" in run.stdout, "Actual WebView retention checks failed"
            observed = json.loads(match[1])
            assert observed["passed"] and observed["phase"] == phase
            result["phases"].append({"phase": phase, "uid": uid, "observed": observed, "apkSha": hashlib.sha256(apk.read_bytes()).hexdigest()})
            print(json.dumps({"phase": phase, "passed": True, "draftPreserved": observed["documentAndChineseDraftPreserved"]}), flush=True)
        result["passed"] = True
    finally:
        if attempted_install:
            assert PACKAGE.fullmatch(package)
            removed = adb("uninstall", package, check=False)
            result["temporaryApplicationRemoved"] = removed.returncode == 0 and "Success" in removed.stdout
            absent = adb("shell", "pm", "path", package, check=False)
            result["temporaryApplicationAbsent"] = absent.returncode in (0, 1) and not absent.stdout.strip()
        current_info = adb("shell", "dumpsys", "package", "com.dshphone").stdout
        current_identity = [line.strip() for line in current_info.splitlines() if any(k in line for k in ("versionCode=", "versionName=", "lastUpdateTime=", "firstInstallTime="))]
        result["productionInstallUnchanged"] = identity == current_identity and original_path == adb("shell", "pm", "path", "com.dshphone").stdout.strip()
        (output / "verification.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    assert result["productionInstallUnchanged"] and result["temporaryApplicationRemoved"] and result["temporaryApplicationAbsent"]


if __name__ == "__main__":
    main()
