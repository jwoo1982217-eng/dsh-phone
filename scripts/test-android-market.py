"""Test the production plugin installer and recovery in a disposable Android UID."""
import argparse
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import uuid

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--adb', default='adb')
    args = parser.parse_args()
    package = 'com.dshphone.marketverification.t' + uuid.uuid4().hex[:12]
    base = [args.adb, '-s', args.serial]
    project = ROOT / 'build-delivery/android-market-test'
    sources = project / 'app/src/main/java/com/dshphone'
    assets = project / 'app/src/main/assets'
    sources.mkdir(parents=True, exist_ok=True)
    assets.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / 'app/src/main/java/com/dshphone/control', sources / 'control', dirs_exist_ok=True)
    for name in ['build.gradle', 'settings.gradle', 'gradle.properties']:
        shutil.copy2(ROOT / name, project / name)
    for name in ['NodeRunner.kt', 'RecoveryManager.kt', 'AndroidImageProcessor.kt']:
        shutil.copy2(ROOT / 'app/src/main/java/com/dshphone' / name, sources / name)
    shutil.copy2(ROOT / 'scripts/android-startup-test/DshService.kt', sources / 'DshService.kt')
    shutil.copy2(ROOT / 'scripts/android-market-test/MarketInstrumentation.kt', sources / 'MarketInstrumentation.kt')
    shutil.copy2(ROOT / 'scripts/android-market-test/driver.mjs', assets / 'driver.mjs')
    for name in ['dsh-tree.tar', 'dsh-home.tar']:
        shutil.copy2(ROOT / 'app/src/main/assets' / name, assets / name)
    shutil.copytree(ROOT / 'app/src/main/jniLibs', project / 'app/src/main/jniLibs', dirs_exist_ok=True)
    manifest = {'name': 'fixture-phone-trial', 'version': '1.0.0', 'type': 'module',
                'dependencies': {'@deepseek-ai/dsh-llm': '^0.2.0'},
                'dsh': {'bundle': {'patch': 'cordis.patch.yml'}},
                'scripts': {'postinstall': 'node -e "throw Error(\'install hook executed\')"'}}
    with tarfile.open(assets / 'fixture.tgz', 'w:gz') as archive:
        for name, text in [('package.json', json.dumps(manifest)), ('cordis.patch.yml', '- insert: []\n')]:
            data = text.encode(); item = tarfile.TarInfo('package/' + name); item.size = len(data); item.mode = 0o600
            archive.addfile(item, io.BytesIO(data))
    (project / 'app/build.gradle').write_text(f"""plugins {{ id 'com.android.application' }}
android {{
 namespace 'com.dshphone'; compileSdk 36
 defaultConfig {{ applicationId '{package}'; minSdk 28; targetSdk 36; versionCode 1; versionName 'test'; ndk {{ abiFilters 'arm64-v8a' }} }}
 packaging {{ jniLibs {{ useLegacyPackaging = true }} }}
 compileOptions {{ sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }}
}}
dependencies {{ implementation 'dev.rikka.shizuku:api:13.1.5'; implementation 'dev.rikka.shizuku:provider:13.1.5' }}
""")
    (project / 'app/src/main/AndroidManifest.xml').write_text(f"""<manifest xmlns:android="http://schemas.android.com/apk/res/android">
<uses-permission android:name="android.permission.INTERNET" />
<application android:label="DSH market verification" android:allowBackup="false" android:extractNativeLibs="true" />
<instrumentation android:name="com.dshphone.MarketInstrumentation" android:targetPackage="{package}" />
</manifest>""")
    with (project / 'build.log').open('w') as log:
        subprocess.run([str(ROOT / 'gradlew'), '--offline', ':app:clean', ':app:assembleDebug'], cwd=project, env=os.environ.copy(), stdout=log, stderr=subprocess.STDOUT, check=True)
    result = {'package': package, 'productionPackageTouched': False}; installed = False
    try:
        subprocess.run([*base, 'install', str(project / 'app/build/outputs/apk/debug/app-debug.apk')], capture_output=True, check=True)
        installed = True
        run = subprocess.run([*base, 'shell', 'am', 'instrument', '-w', '-r', package + '/com.dshphone.MarketInstrumentation'], capture_output=True, text=True, timeout=300, check=True)
        (project / 'instrumentation.log').write_text(run.stdout + run.stderr)
        result['passed'] = 'DSH_MARKET_TESTS_OK' in run.stdout and 'INSTRUMENTATION_CODE: -1' in run.stdout
        result['cases'] = [line for line in run.stdout.splitlines() if 'PASS:' in line]
        if not result['passed']: raise RuntimeError('Isolated Android plugin trial failed; see instrumentation.log')
    finally:
        if installed:
            removed = subprocess.run([*base, 'uninstall', package], capture_output=True, text=True, check=True)
            result['temporaryApplicationRemoved'] = 'Success' in removed.stdout
        (project / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))

if __name__ == '__main__':
    main()
