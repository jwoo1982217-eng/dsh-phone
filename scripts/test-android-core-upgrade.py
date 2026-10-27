"""Run real Node26/core migration/JSONL/native probes in a fresh disposable Android UID."""
import argparse, hashlib, importlib.util, json, os, re, shutil, subprocess, tarfile, time, zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
_spec=importlib.util.spec_from_file_location('mcp_upgrade_guard',ROOT/'scripts/test-android-mcp-upgrade.py');guard=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(guard)
class CoreFixtureDevice(guard.FixtureDevice):
    def instrument(self):
        package=guard.require_fixture_package(self.package)
        command=self.base+['shell','am','instrument','-w','-r',package+'/com.dshphone.CoreUpgradeInstrumentation']
        result=subprocess.run(command,capture_output=True,text=True,timeout=1000)
        self.trace.append({'operation':'instrument-core','command':command,'exitCode':result.returncode,'stdout':result.stdout[-4000:],'stderr':result.stderr[-4000:]});result.check_returncode();return result

def archive_file(archive,source,name):
    if not source.is_file() or source.is_symlink(): raise ValueError('Only reviewed regular code files enter the fixture')
    # Android toybox tar requires explicit parents; production make_tar emits them.
    # The fixture previously archived only regular files, unlike the real assets.
    seen = getattr(archive, '_fixture_dirs', set())
    for parent in reversed(Path(name).parents):
        relative = parent.as_posix()
        if relative == '.' or relative in seen: continue
        info = tarfile.TarInfo(relative + '/'); info.type = tarfile.DIRTYPE; info.mode = 0o700
        archive.addfile(info); seen.add(relative)
    archive._fixture_dirs = seen
    info = archive.gettarinfo(source, arcname=name)
    if not info.isfile(): raise ValueError('Fixture code entry is not a regular file')
    with source.open('rb') as stream: archive.addfile(info, stream)

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True);p.add_argument('--output',required=True);p.add_argument('--tree',required=True);p.add_argument('--old-modules',required=True);p.add_argument('--adb',default=str(Path.home()/'Library/Android/sdk/platform-tools/adb'));p.add_argument('--aapt',default=str(Path.home()/'Library/Android/sdk/build-tools/36.0.0/aapt'));args=p.parse_args()
    output=Path(args.output).resolve()
    if output.exists() and any(output.iterdir()): raise ValueError('Use an empty new evidence directory')
    output.mkdir(parents=True,exist_ok=True);tree=Path(args.tree).resolve();old=Path(args.old_modules).resolve();plan_bytes=(tree/'node_modules/dsh-phone-qq/private-sdk-patches.json').read_bytes();plan=json.loads(plan_bytes)
    if plan.get('version')!=2 or plan.get('sdkVersion')!='0.2.1-rc.2':raise ValueError('Expected final v2 rc2 plan')
    selected=None
    for baseline in plan['baselines']:
        expected={r['relative']:r['sha256']for r in baseline['files']};actual={str(x.relative_to(old)):hashlib.sha256(x.read_bytes()).hexdigest()for x in old.rglob('*')if x.is_file()and not x.is_symlink()}
        if actual==expected:selected=baseline;break
    if selected is None:raise ValueError('Old SDK must match an exact reviewed code-only baseline; never pack a user profile')
    package=guard.new_fixture_package();trace=[];device=CoreFixtureDevice(args.adb,args.serial,package,trace)
    project=output/'test-project';assets=project/'app/src/main/assets';sources=project/'app/src/main/java/com/dshphone';sources.mkdir(parents=True);assets.mkdir(parents=True)
    for name in ['build.gradle','settings.gradle','gradle.properties','local.properties']:shutil.copy2(ROOT/name,project/name)
    shutil.copy2(ROOT/'scripts/android-core-upgrade-test/CoreUpgradeInstrumentation.kt',sources/'CoreUpgradeInstrumentation.kt');shutil.copy2(ROOT/'scripts/android-core-upgrade-test/probe.mjs',assets/'core-upgrade-probe.mjs')
    libraries=project/'app/src/main/jniLibs/arm64-v8a';libraries.mkdir(parents=True)
    native_names=['libnode.so','libdshflock.so','libc++_shared.so','libcares.so','libcrypto.so','libssl.so','libicudata.so','libicui18n.so','libicuuc.so','libffi.so','libsqlite3.so','libz.so','libandroid-support.so']
    for name in native_names:shutil.copy2(ROOT/'app/src/main/jniLibs/arm64-v8a'/name,libraries/name)
    with tarfile.open(assets/'payload.bin','w:gz',compresslevel=1)as archive:
        for item in sorted(tree.rglob('*')):
            if item.is_file():archive_file(archive,item,'tree/'+str(item.relative_to(tree)))
            elif item.is_symlink():raise ValueError('Final tree contains a link: '+str(item.relative_to(tree)))
        for row in selected['files']:archive_file(archive,old/row['relative'],'home/profiles/phone/.dsh-purge-runtime/android-fixture/node_modules/'+row['relative'])
        import io
        for name,content in {'home/profiles/phone/.dsh-purge-runtime/current.json':json.dumps({'owner':'dsh-purge-community-private-runtime-v1','token':'android-fixture','phase':'installed'}),'home/profiles/phone/package.json':'{"name":"phone","dsh":{"profile":{"bundles":[]}}}'} .items():
            data=content.encode();info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o600;archive.addfile(info,io.BytesIO(data))
    if hashlib.sha256((tree/'node_modules/dsh-phone-qq/private-sdk-patches.json').read_bytes()).digest()!=hashlib.sha256(plan_bytes).digest():raise ValueError('Final plan changed during packing; rerun from a stable stage')
    (project/'app/build.gradle').write_text(f"""plugins {{ id 'com.android.application' }}
android {{namespace 'com.dshphone';compileSdk 36
 defaultConfig {{applicationId '{package}';minSdk 28;targetSdk 36;versionCode 1;versionName 'core-test';ndk {{abiFilters 'arm64-v8a'}}}}
 packaging {{jniLibs {{useLegacyPackaging=true;keepDebugSymbols += ["**/libdshflock.so"]}}}}
 androidResources {{noCompress += ['bin']}}
 compileOptions {{sourceCompatibility JavaVersion.VERSION_17;targetCompatibility JavaVersion.VERSION_17}}
}}
""")
    (project/'app/src/main/AndroidManifest.xml').write_text(f'<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="DSH isolated core verification" android:testOnly="true" android:allowBackup="false" android:extractNativeLibs="true"/><instrumentation android:name="com.dshphone.CoreUpgradeInstrumentation" android:targetPackage="{package}"/></manifest>')
    receipt={'package':package,'productionPackageTouched':False,'modelCalls':0,'noNetworkPermission':True,'commands':trace,'sourcePlanSha256':hashlib.sha256(plan_bytes).hexdigest(),'oldBaselineId':selected['id'],'oldCodeFiles':len(selected['files']),'packedTree':str(tree),'nativeLibrarySha256':{n:hashlib.sha256((libraries/n).read_bytes()).hexdigest()for n in native_names}}
    attempted=False
    try:
        assert device.run('state').stdout.strip()=='device';assert not device.run('path',check=False).stdout.strip(),'Refusing to replace an existing package'
        build_env=os.environ.copy()
        if not build_env.get('JAVA_HOME'):
            bundled_jdk=Path('/Applications/Android Studio.app/Contents/jbr/Contents/Home')
            if not (bundled_jdk/'bin/java').is_file():raise ValueError('Set JAVA_HOME to an existing JDK; no global configuration is modified')
            build_env['JAVA_HOME']=str(bundled_jdk)
        with(output/'build.log').open('w')as log:subprocess.run([str(ROOT/'gradlew'),'--offline','--no-daemon',':app:assembleDebug'],cwd=project,env=build_env,stdout=log,stderr=subprocess.STDOUT,timeout=600,check=True)
        apk=project/'app/build/outputs/apk/debug/app-debug.apk';identity=guard.apk_identity(apk,Path(args.aapt));assert identity=={'package':package,'versionCode':1};
        with zipfile.ZipFile(apk)as zipped:
            if 'assets/payload.bin' not in zipped.namelist() or 'assets/core-upgrade-probe.mjs' not in zipped.namelist():raise ValueError('Built APK lost exact fixture asset names')
        receipt['apkSha256']=hashlib.sha256(apk.read_bytes()).hexdigest();attempted=True;device.install(apk,Path(args.aapt),1);receipt['uid']=guard.parse_fixture_uid(device.run('uid').stdout,package)
        tested=device.instrument();(output/'instrumentation.log').write_text(tested.stdout+tested.stderr);match=re.search(r'DSH_ANDROID_CORE_OK (\{[^\n]+\})',tested.stdout);assert match and 'DSH_ANDROID_CORE_INSTRUMENTATION_OK' in tested.stdout and 'INSTRUMENTATION_CODE: -1' in tested.stdout,tested.stdout[-6000:];receipt['probe']=json.loads(match[1]);assert receipt['probe']['uid']==receipt['uid'];receipt['passed']=True
    except BaseException as error:receipt['error']=str(error)[:4000];raise
    finally:
        if attempted:
            removed=device.run('uninstall',check=False);receipt['temporaryApplicationRemoved']=removed.returncode==0 and 'Success'in removed.stdout;receipt['temporaryApplicationAbsent']=not device.run('path',check=False).stdout.strip()
        (output/'android-verification.json').write_text(json.dumps(receipt,indent=2)+'\n')
    assert receipt.get('temporaryApplicationRemoved')and receipt.get('temporaryApplicationAbsent');print(json.dumps({'package':package,'uid':receipt['uid'],'passed':receipt.get('passed'),'temporaryApplicationAbsent':receipt['temporaryApplicationAbsent']}))
if __name__=='__main__':main()
