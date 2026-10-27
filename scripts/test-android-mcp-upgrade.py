"""Verify the production NodeRunner/MCP updater in a fresh disposable app UID.

This is a small synthetic runtime, not a full-core, UI or hardware acceptance test.
No command may install, stop, clear, instrument or uninstall the production app.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PACKAGE = re.compile(r"com\.dshphone\.mcpupgradeverification\.t[a-f0-9]{32}\Z")
NATIVE_DIRS = ("control", "browser", "virtualscreen", "terminal", "workspace", "incoming", "update", "startup")


def new_fixture_package():
    return "com.dshphone.mcpupgradeverification.t" + uuid.uuid4().hex


def require_fixture_package(package):
    if not isinstance(package, str) or not FIXTURE_PACKAGE.fullmatch(package):
        raise ValueError("Refusing any target other than this disposable verification package")
    return package


def asset_version(source):
    match = re.search(r'ASSET_VERSION\s*=\s*"(\d+)"', source)
    if match is None:
        raise ValueError("NodeRunner asset version is missing")
    return match[1]


def apk_identity(apk, aapt):
    result = subprocess.run([str(aapt), "dump", "badging", str(apk)], capture_output=True, text=True, check=True, timeout=30)
    match = re.search(r"^package: name='([^']+)' versionCode='(\d+)'", result.stdout, re.MULTILINE)
    if match is None:
        raise ValueError("Cannot verify the built APK package identity")
    return {"package": match[1], "versionCode": int(match[2])}


def parse_fixture_uid(output, package):
    require_fixture_package(package)
    match = re.fullmatch(r"package:" + re.escape(package) + r" uid:(\d+)\s*", output)
    if match is None or int(match[1]) < 10000:
        raise ValueError("Expected exactly the disposable package and an isolated application UID")
    return int(match[1])


def browser_profile_result(stdout, phase):
    if phase not in ("before", "after"):
        raise ValueError("Unexpected browser probe phase")
    match = re.search(r"DSH_BROWSER_PROFILE_" + phase.upper() + r"_OK (\{[^\n]+\})", stdout)
    if match is None:
        raise ValueError("No actual device browser success report")
    value = json.loads(match[1])
    if value.get("phase") != phase or "mobile" not in value or "desktop" not in value:
        raise ValueError("Browser device report does not match the requested phase")
    return value  # Preserve raw observed numbers; never substitute the requested viewport.


class FixtureDevice:
    """Only fixed operations on the one validated test package; no arbitrary shell seam."""
    def __init__(self, adb, serial, package, trace, keep_awake=False):
        self.base = [adb, "-s", serial]
        self.package = require_fixture_package(package)
        self.trace = trace
        self.keep_awake = keep_awake

    def run(self, operation, *, apk=None, phase=None, check=True):
        package = require_fixture_package(self.package)
        commands = {
            "state": ["get-state"],
            "path": ["shell", "pm", "path", package],
            "uid": ["shell", "pm", "list", "packages", "-U", package],
            "frozen": ["shell", "am", "isfrozen", package],
            "unfreeze": ["shell", "am", "unfreeze", "--sticky", package],
            "uninstall": ["uninstall", package],
        }
        if operation == "instrument" and phase in ("before", "after"):
            commands[operation] = ["shell", "am", "instrument", "-w", "-r", "-e", "phase", phase,
                                   package + "/com.dshphone.McpUpgradeInstrumentation"]
        if operation == "install" and apk is not None:
            commands[operation] = ["install", "-t", "-r", str(apk)]
        if operation not in commands:
            raise ValueError("Unapproved verification operation")
        command = self.base + commands[operation]
        if operation == "unfreeze" and not self.keep_awake:
            raise ValueError("Test-process unfreeze requires explicit fixture opt-in")
        if operation == "instrument" and self.keep_awake:
            # Some OEMs freeze even an instrumentation UID and its native children.
            # Scope this exemption to the disposable process lifetime, never the global freezer.
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 180
            exempted = False
            try:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(command, 180)
                    try:
                        stdout, stderr = process.communicate(timeout=remaining if exempted else min(2, remaining))
                        result = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
                        break
                    except subprocess.TimeoutExpired:
                        if time.monotonic() >= deadline:
                            raise
                        frozen = self.run("frozen", check=False)
                        if frozen.returncode == 0 and frozen.stdout.strip() == "true":
                            self.run("unfreeze")
                            exempted = True
            except BaseException:
                process.kill()
                process.communicate(timeout=10)
                raise
        else:
            result = subprocess.run(command, capture_output=True, text=True, timeout=10 if operation in ("frozen", "unfreeze") else 180)
        self.trace.append({"operation": operation, "command": command, "exitCode": result.returncode,
                           "stdout": result.stdout[-4000:], "stderr": result.stderr[-4000:]})
        if check:
            result.check_returncode()
        return result

    def install(self, apk, aapt, version):
        expected = {"package": require_fixture_package(self.package), "versionCode": version}
        actual = apk_identity(apk, aapt)
        if actual != expected:
            raise ValueError("Refusing APK install: identity does not match this test UID/version")
        return self.run("install", apk=apk)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--output", required=True)
    parser.add_argument("--before-runner", required=True)
    parser.add_argument("--aapt", default=str(Path.home() / "Library/Android/sdk/build-tools/36.0.0/aapt"))
    parser.add_argument("--browser-probe-source", help="Optional device-only Kotlin probe source; copied only into the disposable fixture")
    parser.add_argument("--unfreeze-test-process", action="store_true", help="Only if this disposable process is observed frozen: unfreeze it for its lifetime; never change the global freezer")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError("Use a new empty evidence directory; never overwrite earlier receipts")
    output.mkdir(parents=True, exist_ok=True)
    before = Path(args.before_runner).resolve()
    after = output / "NodeRunner-after.kt"
    shutil.copy2(ROOT / "app/src/main/java/com/dshphone/NodeRunner.kt", after)
    before_version, after_version = asset_version(before.read_text()), asset_version(after.read_text())
    if int(after_version) <= int(before_version):
        raise ValueError("A genuine increasing asset version is required for an upgrade test")
    package = new_fixture_package()
    trace = []
    device = FixtureDevice(args.adb, args.serial, package, trace, keep_awake=args.unfreeze_test_process)
    result = {"package": package, "productionPackageTouched": False, "commands": trace,
              "scope": "synthetic NodeRunner/MCP upgrade only; not full core/UI/hardware",
              "testProcessUnfreezeWatchdogEnabled": args.unfreeze_test_process,
              "beforeAssetVersion": before_version, "afterAssetVersion": after_version,
              "beforeRunnerSha256": hashlib.sha256(before.read_bytes()).hexdigest(),
              "afterRunnerSha256": hashlib.sha256(after.read_bytes()).hexdigest()}
    project = output / "test-project"
    sources = project / "app/src/main/java/com/dshphone"
    assets = project / "app/src/main/assets"
    sources.mkdir(parents=True)
    assets.mkdir(parents=True)
    for name in ("build.gradle", "settings.gradle", "gradle.properties", "local.properties"):
        if (ROOT / name).exists():
            shutil.copy2(ROOT / name, project / name)
    # Compile current transitive native dependencies without registering/launching their components.
    for name in NATIVE_DIRS:
        shutil.copytree(ROOT / "app/src/main/java/com/dshphone" / name, sources / name)
    for name in ("RecoveryManager.kt", "AndroidImageProcessor.kt", "BundledResources.kt",
                 "BundledPackageUpgrade.kt", "OfmCompatibility.kt", "StorageAccess.kt"):
        shutil.copy2(ROOT / "app/src/main/java/com/dshphone" / name, sources / name)
    shutil.copy2(ROOT / "scripts/android-startup-test/DshService.kt", sources / "DshService.kt")
    shutil.copy2(ROOT / "scripts/android-mcp-upgrade-test/McpUpgradeInstrumentation.kt", sources / "McpUpgradeInstrumentation.kt")
    if args.browser_probe_source:
        probe = Path(args.browser_probe_source).resolve()
        if not probe.is_file() or probe.suffix != ".kt":
            raise ValueError("Expected a device-only Kotlin probe source")
        shutil.copy2(probe, sources / "BrowserUpgradeProbe.kt")
        instrumentation = sources / "McpUpgradeInstrumentation.kt"
        original = instrumentation.read_text()
        marker = '            finish(Activity.RESULT_OK,Bundle().apply'
        if original.count(marker) != 1:
            raise ValueError("Instrumentation success checkpoint changed; do not inject heuristically")
        instrumentation.write_text(original.replace(marker, '            BrowserUpgradeProbe.verify(this, phase)\n' + marker))
        shutil.copy2(ROOT / "app/src/main/assets/dsh-browser-dom.js", assets / "dsh-browser-dom.js")
        result["browserProbeSha256"] = hashlib.sha256(probe.read_bytes()).hexdigest()
        result["browserProbeEnabled"] = True
        result["scope"] = "synthetic NodeRunner/MCP upgrade and actual headless BrowserService profile; not full core/UI/hardware"
    shutil.copytree(ROOT / "app/src/main/jniLibs", project / "app/src/main/jniLibs")
    result["nativeSourceDirectories"] = list(NATIVE_DIRS)
    # Small blank assets; only NodeRunner and the production MCP migration/launcher run.
    tree, home = output / "tree", output / "home"
    peer = tree / "node_modules/dsh-peer/mcp-manager"
    peer.mkdir(parents=True)
    for name in ("upgrade.mjs", "launch.mjs"):
        shutil.copy2(ROOT / "peer/mcp-manager" / name, peer / name)
    (assets / "before-version.txt").write_text(before_version)
    binfile = tree / "node_modules/@deepseek-ai/dsh/lib/bin.js"
    binfile.parent.mkdir(parents=True)
    binfile.write_text("// isolated fixture; no engine starts\n")
    profile = home / "profiles/phone"
    profile.mkdir(parents=True)
    (profile / "package.json").write_text('{"name":"phone","dsh":{"profile":{"bundles":[]}}}')
    ofm = profile / "node_modules/dsh-our-free-model"
    ofm.mkdir(parents=True)
    (ofm / "package.json").write_text('{"name":"dsh-our-free-model","version":"2.1.0"}')
    shutil.copytree(tree / "node_modules/dsh-peer", profile / "node_modules/dsh-peer")
    (home / "settings.yaml").write_text("")
    for name, source in (("dsh-tree.tar", tree), ("dsh-home.tar", home)):
        with tarfile.open(assets / name, "w") as archive:
            for item in sorted(source.rglob("*")):
                archive.add(item, arcname=str(item.relative_to(source)), recursive=False)
    (assets / "fixture-server.mjs").write_text("import {marker} from './marker.mjs';\nimport readline from 'node:readline';\nfor await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);let result;if(q.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};else if(q.method==='tools/list')result={tools:['generate_image','generate_video','generate_audio'].map(name=>({name,inputSchema:{type:'object'}}))};else result={content:[{type:'text',text:marker}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}\n")
    browser_service = '<service android:name="com.dshphone.browser.BrowserService" android:exported="false"/>' if args.browser_probe_source else ''
    (project / "app/src/main/AndroidManifest.xml").write_text(
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">'
        '<uses-permission android:name="android.permission.INTERNET"/>'
        '<application android:label="DSH isolated upgrade verification" android:testOnly="true" '
        f'android:allowBackup="false" android:extractNativeLibs="true" android:usesCleartextTraffic="true">{browser_service}</application>'
        f'<instrumentation android:name="com.dshphone.McpUpgradeInstrumentation" android:targetPackage="{package}"/>'
        '</manifest>')
    attempted_install = False
    try:
        assert device.run("state").stdout.strip() == "device", "Selected device is not ready"
        existing = device.run("path", check=False)
        assert existing.returncode in (0, 1) and not existing.stdout.strip(), "Refusing to replace an existing app"
        for phase, code in (("before", 1), ("after", 2)):
            shutil.copy2(before if phase == "before" else after, sources / "NodeRunner.kt")
            (project / "app/build.gradle").write_text(f"""plugins {{ id 'com.android.application' }}
android {{namespace 'com.dshphone';compileSdk 36
 defaultConfig {{applicationId '{package}';minSdk 28;targetSdk 36;versionCode {code};versionName '{phase}';ndk {{abiFilters 'arm64-v8a'}}}}
 packaging {{jniLibs {{useLegacyPackaging=true;keepDebugSymbols += ["**/libdshopencode*.so"]}}}}
 compileOptions {{sourceCompatibility JavaVersion.VERSION_17;targetCompatibility JavaVersion.VERSION_17}}
}}
dependencies {{implementation 'androidx.core:core:1.17.0';implementation 'androidx.webkit:webkit:1.12.1';implementation 'dev.rikka.shizuku:api:13.1.5';implementation 'dev.rikka.shizuku:provider:13.1.5'}}
""")
            with (output / (phase + "-build.log")).open("w") as log:
                subprocess.run([str(ROOT / "gradlew"), "--offline", "--no-daemon", ":app:clean", ":app:assembleDebug"],
                               cwd=project, env=os.environ.copy(), stdout=log, stderr=subprocess.STDOUT,
                               check=True, timeout=600)
            apk = project / "app/build/outputs/apk/debug/app-debug.apk"
            identity = apk_identity(apk, Path(args.aapt))
            if identity != {"package": package, "versionCode": code}:
                raise ValueError("Built APK does not belong to this disposable UID")
            shutil.copy2(apk, output / (phase + ".apk"))
            result[phase + "ApkSha256"] = hashlib.sha256(apk.read_bytes()).hexdigest()
            attempted_install = True
            device.install(apk, Path(args.aapt), code)
            uid = parse_fixture_uid(device.run("uid").stdout, package)
            result[phase + "Uid"] = uid
            if phase == "after":
                assert uid == result["beforeUid"], "Upgrade did not preserve the isolated UID"
                result["sameUidAcrossUpgrade"] = True
            tested = device.run("instrument", phase=phase)
            (output / (phase + "-device.log")).write_text(tested.stdout + tested.stderr)
            result[phase + "Passed"] = (f"DSH_MCP_UPGRADE_{phase.upper()}_OK" in tested.stdout
                                        and "INSTRUMENTATION_CODE: -1" in tested.stdout)
            if args.browser_probe_source:
                result[phase + "BrowserPassed"] = f"DSH_BROWSER_PROFILE_{phase.upper()}_OK" in tested.stdout
                assert result[phase + "BrowserPassed"], tested.stdout
                profile = browser_profile_result(tested.stdout, phase)
                (output / ("browser-profile-" + phase + ".json")).write_text(json.dumps(profile, ensure_ascii=False, indent=2))
            if phase == "after":
                result["staleLoaderPathReproduced"] = "REPRODUCED_STALE_LD_LIBRARY_PATH" in tested.stdout
                result["newerIndependentPluginPreserved"] = "PRESERVED_NEWER_INDEPENDENT_PLUGIN" in tested.stdout
                assert result["newerIndependentPluginPreserved"], tested.stdout
            assert result[phase + "Passed"], tested.stdout
    except BaseException as error:
        result["error"] = f"{type(error).__name__}: {str(error)[:2000]}"
        raise
    finally:
        if attempted_install:
            try:
                removed = device.run("uninstall", check=False)
                result["temporaryApplicationRemoved"] = removed.returncode == 0 and "Success" in removed.stdout
                result["temporaryApplicationAbsent"] = not device.run("path", check=False).stdout.strip()
            except Exception as cleanup:
                result["cleanupError"] = str(cleanup)
        (output / "android-verification.json").write_text(json.dumps(result, indent=2))
    assert result.get("temporaryApplicationRemoved") and result.get("temporaryApplicationAbsent"), "Disposable app cleanup failed"
    print(json.dumps(result))


if __name__ == "__main__":
    main()
