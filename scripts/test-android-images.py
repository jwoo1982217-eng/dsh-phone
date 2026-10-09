"""Test Android image admission and projection in an isolated app without touching user DSH data."""
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
    from PIL import Image
    fixtures = ROOT / 'build-delivery/android-image-fixtures'
    fixtures.mkdir(parents=True, exist_ok=True)
    Image.new('RGB', (1080, 2340), 'white').save(fixtures / 'screenshot.png')
    exif = Image.Exif(); exif[274] = 6
    Image.new('RGB', (120, 80), '#2468ac').save(fixtures / 'rotated.jpg', exif=exif)
    alpha = Image.new('RGBA', (80, 60), (0, 0, 0, 0)); alpha.putpixel((20, 20), (0, 0, 0, 255))
    alpha.save(fixtures / 'transparent.webp', lossless=True)
    frames = [Image.new('RGB', (64, 48), color) for color in ['white', 'black']]
    frames[0].save(fixtures / 'animated.gif', save_all=True, append_images=frames[1:], duration=100, loop=0)
    Image.new('I;16', (70, 50), 12345).save(fixtures / '16bit.png')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--adb', default='adb')
    args = parser.parse_args()
    package = 'com.dshphone.imageverification.t' + uuid.uuid4().hex[:12]
    base = [args.adb, '-s', args.serial]
    project = ROOT / 'build-delivery/android-image-test'
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
    shutil.copy2(ROOT / 'scripts/android-startup-test/DshService.kt', sources / 'DshService.kt')
    shutil.copy2(ROOT / 'scripts/android-image-test/ImageInstrumentation.kt', sources / 'ImageInstrumentation.kt')
    for name in ['dsh-tree.tar', 'dsh-home.tar']:
        shutil.copy2(ROOT / 'app/src/main/assets' / name, assets / name)
    shutil.copy2(ROOT / 'scripts/android-image-test/smoke.mjs', assets / 'android-image-smoke.mjs')
    shutil.copytree(ROOT / 'build-delivery/android-image-fixtures', assets / 'image-fixtures', dirs_exist_ok=True)
    # A clean directory prevents stale helpers from masking missing shipped libraries.
    if libraries.exists(): shutil.rmtree(libraries)
    shutil.copytree(ROOT / 'app/src/main/jniLibs', libraries)
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
<application android:label="DSH tool verification" android:allowBackup="false" android:extractNativeLibs="true" />
<instrumentation android:name="com.dshphone.ImageInstrumentation" android:targetPackage="{package}" />
</manifest>
""")
    with (ROOT / 'build-delivery/android-image-build.log').open('w') as log:
        subprocess.run([str(ROOT / 'gradlew'), '--offline', '--no-daemon', ':app:clean', ':app:assembleDebug'],
                       cwd=project, env=os.environ.copy(), stdout=log, stderr=subprocess.STDOUT, check=True)
    existing = subprocess.run([*base, 'shell', 'pm', 'path', package], capture_output=True, text=True)
    if existing.stdout.strip(): raise RuntimeError('Refusing to replace an existing test application')
    installed = False
    result = {'package': package, 'productionPackageTouched': False,
              'nodeRunnerSourceSha256': hashlib.sha256((sources / 'NodeRunner.kt').read_bytes()).hexdigest()}
    try:
        subprocess.run([*base, 'install', str(project / 'app/build/outputs/apk/debug/app-debug.apk')],
                       check=True, capture_output=True, text=True)
        installed = True
        test = subprocess.run([*base, 'shell', 'am', 'instrument', '-w', '-r', package + '/com.dshphone.ImageInstrumentation'],
                              capture_output=True, text=True, timeout=240, check=True)
        (ROOT / 'build-delivery/android-image-tests.log').write_text(test.stdout + test.stderr)
        result['imagesTestsPassed'] = 'DSH_ANDROID_IMAGES_OK' in test.stdout and 'INSTRUMENTATION_CODE: -1' in test.stdout
        if not result['imagesTestsPassed']:
            print(test.stdout)
            raise RuntimeError('Android image verification failed')
    finally:
        if installed:
            removed = subprocess.run([*base, 'uninstall', package], capture_output=True, text=True, check=True)
            result['temporaryApplicationRemoved'] = 'Success' in removed.stdout
        (ROOT / 'build-delivery/android-image-verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__': main()
