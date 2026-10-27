"""Real 119→121 legacy APK upgrade under a disposable UID; never installs com.dshphone."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'com.dshphone.compactionverification.t'

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--project',required=True);p.add_argument('--output',required=True)
    p.add_argument('--old-runner',required=True);p.add_argument('--serial',required=True)
    p.add_argument('--adb',required=True);p.add_argument('--port',default='5069')
    p.add_argument('--aapt',required=True)
    args = p.parse_args()
    project, output = Path(args.project).resolve(),Path(args.output).resolve()
    if not (project/'compaction-source.json').is_file(): raise ValueError('Not a prepared maintenance project')
    output.mkdir(parents=True,exist_ok=True)
    package = PREFIX+uuid.uuid4().hex
    if not re.fullmatch(re.escape(PREFIX)+'[a-f0-9]{32}',package): raise ValueError('Unsafe test identity')
    adb = [args.adb,'-P',args.port,'-s',args.serial]
    trace = []
    def device(tail, absent_ok=False):
        result = subprocess.run(adb+tail,capture_output=True,text=True,timeout=180)
        trace.append(dict(command=adb+tail,exitCode=result.returncode,stdout=result.stdout[-8000:],stderr=result.stderr[-2000:]))
        if not (absent_ok and result.returncode in (0,1) and not result.stdout.strip()):
            result.check_returncode()
        return result.stdout
    manifest = project/'app/src/main/AndroidManifest.xml'
    gradle = project/'app/build.gradle'
    runner = project/'app/src/main/java/com/dshphone/NodeRunner.kt'
    originals = {f:f.read_bytes() for f in (manifest,gradle,runner)}
    fixture = project/'app/src/main/java/com/dshphone/CompactionUpgradeInstrumentation.kt'
    asset = project/'app/src/main/assets/fixture-old-runner.mjs'
    legacy_asset = project/'app/src/main/assets/fixture-legacy-index.js'
    old = Path(args.old_runner).read_bytes()
    if hashlib.sha256(old).hexdigest() != '524b97de30f99d816fbf81da6936ac3c2bf1a0bc27d88c8dce83d349aab924e7': raise ValueError('Unknown old runner')
    report = dict(package=package,productionPackageTouched=False,trace=trace)
    attempted = False
    # This probe exercises the incremental upgrade path, which must not extract
    # a full runtime. Keep those large inputs in this same registered project.
    parked = []
    parked_dir = project/'.compaction-fixture-inputs'
    try:
        if device(['shell','pm','path',package],absent_ok=True).strip(): raise ValueError('Existing test identity')
        if parked_dir.exists(): raise ValueError('Previous fixture inputs need recovery')
        parked_dir.mkdir()
        for source in [project/'app/src/main/assets/dsh-tree.tar',project/'app/src/main/assets/dsh-home.tar',project/'app/src/main/jniLibs']:
            if source.exists():
                target = parked_dir/source.name
                source.rename(target);parked.append((source,target))
        shutil.copy2(ROOT/'scripts/android-compaction-test/CompactionUpgradeInstrumentation.kt',fixture)
        asset.write_bytes(old)
        legacy = ROOT/'scripts/android-compaction-test/legacy-index.js'
        if hashlib.sha256(legacy.read_bytes()).hexdigest() != 'caf334c3293b3113969de5d49d4e91d6d9a1019fc1d9cc60ca1e6d1aee72cbee':
            raise ValueError('Unknown legacy fixture')
        shutil.copy2(legacy,legacy_asset)
        manifest.write_text(f'<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="DSH compaction isolated verification" android:testOnly="true" android:allowBackup="false" android:extractNativeLibs="true"/><instrumentation android:name="com.dshphone.CompactionUpgradeInstrumentation" android:targetPackage="{package}"/></manifest>')
        for phase,code in [('before',119),('after',121)]:
            gradle.write_text(originals[gradle].decode().replace('applicationId "com.dshphone"',f'applicationId "{package}"').replace('versionCode 121',f'versionCode {code}'))
            runner.write_text(originals[runner].decode().replace('ASSET_VERSION = "121"',f'ASSET_VERSION = "{code}"'))
            with (output/(phase+'-build.log')).open('w') as log:
                subprocess.run([str(project/'gradlew'),'--offline','--no-daemon',':app:assembleDebug'],cwd=project,env=os.environ.copy(),stdout=log,stderr=subprocess.STDOUT,check=True,timeout=600)
            apk = project/'app/build/outputs/apk/debug/app-debug.apk'
            badging = subprocess.check_output([args.aapt,'dump','badging',str(apk)],text=True)
            if not re.search(r"package: name='"+re.escape(package)+r"' versionCode='"+str(code)+r"'",badging): raise ValueError('Wrong APK identity')
            report[phase+'ApkSha256'] = hashlib.file_digest(apk.open('rb'),'sha256').hexdigest()
            attempted = True
            if 'Success' not in device(['install','-t','-r',str(apk)]): raise ValueError('Fixture installation failed')
            uid = device(['shell','pm','list','packages','-U',package]).strip()
            report[phase+'Uid'] = uid
            if phase == 'after' and uid != report['beforeUid']: raise ValueError('UID changed across upgrade')
            result = device(['shell','am','instrument','-w','-r','-e','phase',phase,package+'/com.dshphone.CompactionUpgradeInstrumentation'])
            (output/(phase+'-device.log')).write_text(result)
            if f'DSH_COMPACTION_{phase.upper()}_OK' not in result or 'INSTRUMENTATION_CODE: -1' not in result: raise ValueError('Actual Android probe failed: '+result)
            report[phase+'Passed'] = True
        report.update(sameUidAcrossUpgrade=True,activePrivateSdkUpdated=True,userDataPreserved=True,unknownPatchRejected=True,symlinkRejected=True,rollbackPassed=True,concurrentEditPreserved=True,idempotent=True)
    except BaseException as error:
        report['error'] = str(error)
        raise
    finally:
        for f,data in originals.items(): f.write_bytes(data)
        fixture.unlink(missing_ok=True);asset.unlink(missing_ok=True);legacy_asset.unlink(missing_ok=True)
        for source,target in parked:
            if source.exists(): raise ValueError('Fixture inputs changed during verification')
            target.rename(source)
        if parked_dir.exists(): parked_dir.rmdir()
        if attempted:
            try:
                report['testAppRemoved'] = 'Success' in device(['uninstall',package])
                report['testAppAbsent'] = not device(['shell','pm','path',package],absent_ok=True).strip()
            except Exception as cleanup_error:
                report['cleanupPending'] = str(cleanup_error)
        (output/'android-upgrade.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='trace'}))

if __name__ == '__main__': main()
