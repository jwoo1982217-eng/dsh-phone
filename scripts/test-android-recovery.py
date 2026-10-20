"""Exercise production recovery on Android in a disposable UID; never replace or stop real DSH."""
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
    args = parser.parse_args()
    package = 'com.dshphone.recoveryverification.t' + uuid.uuid4().hex[:12]
    base = [args.adb, '-s', args.serial]
    project = ROOT / 'build-delivery/android-recovery-test'
    sources = project / 'app/src/main/java/com/dshphone'
    sources.mkdir(parents=True, exist_ok=True)
    for name in ['build.gradle', 'settings.gradle', 'gradle.properties']:
        shutil.copy2(ROOT / name, project / name)
    shutil.copy2(ROOT / 'app/src/main/java/com/dshphone/RecoveryManager.kt', sources / 'RecoveryManager.kt')
    for name in ['NodeRunner.kt', 'RecoveryInstrumentation.kt']:
        shutil.copy2(ROOT / 'scripts/android-recovery-test' / name, sources / name)
    (project / 'app/build.gradle').write_text(f"""plugins {{ id 'com.android.application' }}
android {{
    namespace 'com.dshphone'; compileSdk 36
    defaultConfig {{ applicationId '{package}'; minSdk 28; targetSdk 36; versionCode 1; versionName 'test' }}
    compileOptions {{ sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }}
}}
""")
    (project / 'app/src/main/AndroidManifest.xml').write_text(f"""<manifest xmlns:android="http://schemas.android.com/apk/res/android">
<application android:label="DSH recovery verification" android:allowBackup="false" />
<instrumentation android:name="com.dshphone.RecoveryInstrumentation" android:targetPackage="{package}" />
</manifest>
""")
    with (project / 'build.log').open('w') as log:
        subprocess.run([str(ROOT / 'gradlew'), '--offline', ':app:clean', ':app:assembleDebug'],
                       cwd=project, env=os.environ.copy(), stdout=log, stderr=subprocess.STDOUT, check=True)
    installed = False
    result = {'package': package, 'productionPackageTouched': False}
    try:
        subprocess.run([*base, 'install', str(project / 'app/build/outputs/apk/debug/app-debug.apk')], check=True, capture_output=True)
        installed = True
        test = subprocess.run([*base, 'shell', 'am', 'instrument', '-w', '-r', package + '/com.dshphone.RecoveryInstrumentation'], capture_output=True, text=True, timeout=180, check=True)
        (project / 'instrumentation.log').write_text(test.stdout + test.stderr)
        result['passed'] = 'DSH_RECOVERY_TESTS_OK' in test.stdout and 'INSTRUMENTATION_CODE: -1' in test.stdout
        result['cases'] = [line for line in test.stdout.splitlines() if 'PASS:' in line]
        if not result['passed']:
            raise RuntimeError('Android recovery tests failed; see private instrumentation log')
    finally:
        if installed:
            removed = subprocess.run([*base, 'uninstall', package], check=True, capture_output=True, text=True)
            result['temporaryApplicationRemoved'] = 'Success' in removed.stdout
        (project / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
