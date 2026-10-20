"""Exercise the real draggable accessibility stop window in a disposable UID."""
import argparse, hashlib, json, os, shutil, subprocess, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--serial', required=True); p.add_argument('--output', type=Path, required=True)
    args = p.parse_args(); output = args.output; output.mkdir(parents=True, exist_ok=True)
    project = output / 'project'; sources = project / 'app/src/main/java/com/dshphone/control'
    resources = project / 'app/src/main/res/xml'; sources.mkdir(parents=True); resources.mkdir(parents=True)
    package = 'com.dshphone.stopoverlayverification.t' + uuid.uuid4().hex[:12]
    component = package + '/com.dshphone.control.OverlayFixtureService'
    adb = ['adb', '-P', '5037', '-s', args.serial]
    def shell(*parts):
        return subprocess.check_output([*adb, 'shell', *parts], text=True).strip()
    for name in ['build.gradle', 'settings.gradle', 'gradle.properties', 'local.properties']:
        if (ROOT/name).exists(): shutil.copy2(ROOT/name, project/name)
    source = ROOT/'app/src/main/java/com/dshphone/control/StopOverlay.kt'
    shutil.copy2(source, sources/source.name)
    shutil.copy2(ROOT/'scripts/android-stop-overlay-test/OverlayInstrumentation.kt', sources/'OverlayInstrumentation.kt')
    (project/'app/build.gradle').write_text(f"""plugins {{ id 'com.android.application' }}
android {{ namespace 'com.dshphone.control'; compileSdk 36
defaultConfig {{ applicationId '{package}'; minSdk 28; targetSdk 36; versionCode 1; versionName 'test' }}
compileOptions {{sourceCompatibility JavaVersion.VERSION_17;targetCompatibility JavaVersion.VERSION_17}}
}}
""")
    (resources/'overlay.xml').write_text('''<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
android:accessibilityEventTypes="typeWindowStateChanged" android:accessibilityFeedbackType="feedbackGeneric"
android:canRetrieveWindowContent="false" android:canPerformGestures="false" android:notificationTimeout="100"/>''')
    (project/'app/src/main/AndroidManifest.xml').write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android">
<application android:allowBackup="false" android:label="DSH stop overlay test" android:theme="@android:style/Theme.Material.Light.NoActionBar">
<activity android:name="com.dshphone.control.OverlayFixtureActivity" android:exported="false" android:configChanges="orientation|screenSize"/>
<service android:name="com.dshphone.control.OverlayFixtureService" android:exported="true" android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">
<intent-filter><action android:name="android.accessibilityservice.AccessibilityService"/></intent-filter>
<meta-data android:name="android.accessibilityservice" android:resource="@xml/overlay"/></service>
</application><instrumentation android:name="com.dshphone.control.OverlayInstrumentation" android:targetPackage="{package}"/></manifest>''')
    receipt = {'package': package, 'productionPackageTouched': False, 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest()}
    with (output/'build.log').open('w') as log:
        subprocess.run([str(ROOT/'gradlew'), '--offline', '--no-daemon', '--max-workers=2', '--no-parallel', ':app:assembleDebug'], cwd=project, env=os.environ.copy(), stdout=log, stderr=subprocess.STDOUT, check=True)
    existing = subprocess.run([*adb,'shell','pm','path',package], capture_output=True, text=True)
    assert existing.returncode in (0,1) and not existing.stdout.strip(), 'Refusing to replace any existing application'
    original = shell('settings','get','secure','enabled_accessibility_services')
    enabled = shell('settings','get','secure','accessibility_enabled')
    receipt['productionPidBefore'] = shell('pidof','com.dshphone')
    installed = False
    try:
        subprocess.run([*adb, 'install', str(project/'app/build/outputs/apk/debug/app-debug.apk')], capture_output=True, check=True); installed = True
        # Instrumentation restarts its target process. Bind our service only
        # after that restart, without suppressing the real app's service.
        subprocess.run([*adb,'shell','cmd','appops','set',package,'ACCESS_RESTRICTED_SETTINGS','allow'], capture_output=True, text=True)
        run = subprocess.run([*adb, 'shell','am','instrument','-w','-r', package+'/com.dshphone.control.OverlayInstrumentation'], capture_output=True, text=True, timeout=120, check=True)
        (output/'device.log').write_text(run.stdout+run.stderr)
        report = next((json.loads(line) for line in run.stdout.splitlines() if line.startswith('{') and '"cases"' in line), {})
        receipt.update(report)
        if not receipt.get('passed'):
            (output/'accessibility-at-failure.txt').write_text(shell('dumpsys','accessibility'))
        assert receipt.get('passed') and 'DSH_STOP_OVERLAY_OK' in run.stdout and 'INSTRUMENTATION_CODE: -1' in run.stdout, run.stdout
        screenshot = subprocess.check_output([*adb,'exec-out','run-as',package,'cat','files/overlay-drag.png'])
        (output/'overlay-drag.png').write_bytes(screenshot)
    finally:
        if installed:
            # Remove only our temporary service; retain any concurrent user changes.
            current = shell('settings','get','secure','enabled_accessibility_services')
            kept = [s for s in current.split(':') if s and s != component and s != 'null']
            if kept: shell('settings','put','secure','enabled_accessibility_services', ':'.join(kept))
            else:
                shell('settings','delete','secure','enabled_accessibility_services')
                if enabled != '1': shell('settings','put','secure','accessibility_enabled', enabled if enabled in ['0','1'] else '0')
            receipt['temporaryApplicationRemoved'] = 'Success' in subprocess.check_output([*adb,'uninstall',package], text=True)
        receipt['productionPidAfter'] = shell('pidof','com.dshphone')
        final = shell('settings','get','secure','enabled_accessibility_services')
        receipt['originalAccessibilityServicesRetained'] = all(s in final.split(':') for s in original.split(':') if s and s != 'null')
        (output/'verification.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(receipt, ensure_ascii=False))

if __name__ == '__main__': main()
