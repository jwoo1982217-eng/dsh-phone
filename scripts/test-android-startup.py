"""Exercise the production NodeRunner in a disposable app; never touch com.dshphone."""
import argparse
import hashlib
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
    parser.add_argument('--baseline', default='03a9012625008c3315acec888122cdb276c6e49b')
    args = parser.parse_args()
    package = 'com.dshphone.startupverification.t' + uuid.uuid4().hex[:12]
    base = [args.adb, '-s', args.serial]
    project = ROOT / 'build-delivery/android-startup-test'
    sources = project / 'app/src/main/java/com/dshphone'
    assets = project / 'app/src/main/assets'
    libraries = project / 'app/src/main/jniLibs'
    sources.mkdir(parents=True, exist_ok=True)
    assets.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / 'app/src/main/java/com/dshphone/control', sources / 'control', dirs_exist_ok=True)
    for name in ['build.gradle', 'settings.gradle', 'gradle.properties']:
        shutil.copy2(ROOT / name, project / name)
    shutil.copy2(ROOT / 'app/src/main/java/com/dshphone/NodeRunner.kt', sources / 'NodeRunner.kt')
    shutil.copy2(ROOT / 'app/src/main/java/com/dshphone/RecoveryManager.kt', sources / 'RecoveryManager.kt')
    shutil.copy2(ROOT / 'app/src/main/java/com/dshphone/AndroidImageProcessor.kt', sources / 'AndroidImageProcessor.kt')
    for name in ['DshService.kt', 'StartupInstrumentation.kt']:
        shutil.copy2(ROOT / 'scripts/android-startup-test' / name, sources / name)
    for name in ['dsh-tree.tar', 'dsh-home.tar']:
        shutil.copy2(ROOT / 'app/src/main/assets' / name, assets / name)
    (assets / 'core-migration-before.js').write_bytes(subprocess.check_output([
        'git', 'show', args.baseline + ':phone-qq/core-migration.js'
    ], cwd=ROOT))
    shutil.copytree(ROOT / 'app/src/main/jniLibs', libraries, dirs_exist_ok=True)
    (project / 'app/build.gradle').write_text(f"""plugins {{ id 'com.android.application' }}
android {{
    namespace 'com.dshphone'
    compileSdk 36
    defaultConfig {{ applicationId '{package}'; minSdk 28; targetSdk 36; versionCode 1; versionName 'test'; ndk {{ abiFilters 'arm64-v8a' }} }}
    packaging {{ jniLibs {{ useLegacyPackaging = true }} }}
    compileOptions {{ sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }}
}}
dependencies {{ implementation 'dev.rikka.shizuku:api:13.1.5'; implementation 'dev.rikka.shizuku:provider:13.1.5' }}
""")
    (project / 'app/src/main/AndroidManifest.xml').write_text(f"""<manifest xmlns:android="http://schemas.android.com/apk/res/android">
<uses-permission android:name="android.permission.INTERNET" />
<application android:label="DSH startup verification" android:allowBackup="false" android:extractNativeLibs="true" />
<instrumentation android:name="com.dshphone.StartupInstrumentation" android:targetPackage="{package}" />
</manifest>
""")
    env = os.environ.copy()
    # Honor the invoking environment; the root project uses the same SDK/JDK.
    build_log = ROOT / 'build-delivery/entrypoint-android-launcher-build.log'
    with build_log.open('w') as log:
        subprocess.run([str(ROOT / 'gradlew'), '--offline', '--no-daemon', ':app:clean', ':app:assembleDebug'],
                       cwd=project, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    existing = subprocess.run([*base, 'shell', 'pm', 'path', package], capture_output=True, text=True)
    if existing.stdout.strip():
        raise RuntimeError('Refusing to replace an existing verification application')
    apk = project / 'app/build/outputs/apk/debug/app-debug.apk'
    installed = False
    result = {'package': package, 'productionPackageTouched': False,
              'nodeRunnerSourceSha256': hashlib.sha256((sources / 'NodeRunner.kt').read_bytes()).hexdigest()}
    try:
        subprocess.run([*base, 'install', str(apk)], check=True, capture_output=True, text=True)
        installed = True
        test = subprocess.run([*base, 'shell', 'am', 'instrument', '-w', '-r', package + '/com.dshphone.StartupInstrumentation'],
                              capture_output=True, text=True, timeout=240, check=True)
        (ROOT / 'build-delivery/entrypoint-android-launcher-tests.log').write_text(test.stdout + test.stderr)
        result['startupTestsPassed'] = 'DSH_STARTUP_TESTS_OK' in test.stdout and 'INSTRUMENTATION_CODE: -1' in test.stdout
        result['baselineEmptyOutputReproduced'] = 'reproduced 0.1.26 empty-output error on Android' in test.stdout
        if not result['startupTestsPassed'] or not result['baselineEmptyOutputReproduced']:
            raise RuntimeError('Android launcher verification failed; see entrypoint-android-launcher-tests.log')
    finally:
        if installed:
            removed = subprocess.run([*base, 'uninstall', package], capture_output=True, text=True, check=True)
            result['temporaryApplicationRemoved'] = 'Success' in removed.stdout
        (ROOT / 'build-delivery/entrypoint-android-launcher-verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
