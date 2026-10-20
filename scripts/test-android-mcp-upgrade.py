"""Verify production updater across two APK installs in a disposable app UID."""
import argparse,hashlib,json,os,re,shutil,subprocess,tarfile,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True);p.add_argument('--adb',default='adb');p.add_argument('--output',required=True);p.add_argument('--before-runner',required=True);args=p.parse_args()
    output=Path(args.output);output.mkdir(parents=True,exist_ok=True)
    project=output/'test-project';sources=project/'app/src/main/java/com/dshphone';assets=project/'app/src/main/assets';sources.mkdir(parents=True,exist_ok=True);assets.mkdir(parents=True,exist_ok=True)
    package='com.dshphone.mcpupgradeverification.t'+uuid.uuid4().hex[:12];base=[args.adb,'-s',args.serial]
    for name in ['build.gradle','settings.gradle','gradle.properties']:shutil.copy2(ROOT/name,project/name)
    shutil.copytree(ROOT/'app/src/main/java/com/dshphone/control',sources/'control')
    shutil.copytree(ROOT/'app/src/main/java/com/dshphone/browser',sources/'browser')
    for name in ['RecoveryManager.kt','AndroidImageProcessor.kt','BundledResources.kt','BundledPackageUpgrade.kt','OfmCompatibility.kt']:shutil.copy2(ROOT/'app/src/main/java/com/dshphone'/name,sources/name)
    shutil.copy2(ROOT/'scripts/android-startup-test/DshService.kt',sources/'DshService.kt')
    shutil.copy2(ROOT/'scripts/android-mcp-upgrade-test/McpUpgradeInstrumentation.kt',sources/'McpUpgradeInstrumentation.kt')
    shutil.copytree(ROOT/'app/src/main/jniLibs',project/'app/src/main/jniLibs')
    # Small blank assets; the production updater is used byte for byte.
    tree=output/'tree';home=output/'home';peer=tree/'node_modules/dsh-peer/mcp-manager';peer.mkdir(parents=True)
    for name in ['upgrade.mjs','launch.mjs']:shutil.copy2(ROOT/'peer/mcp-manager'/name,peer/name)
    (assets/'before-version.txt').write_text(re.search(r'ASSET_VERSION\s*=\s*"(\d+)"',Path(args.before_runner).read_text())[1])
    binfile=tree/'node_modules/@deepseek-ai/dsh/lib/bin.js';binfile.parent.mkdir(parents=True);binfile.write_text('// isolated fixture; no engine starts\n')
    profile=home/'profiles/phone';profile.mkdir(parents=True);(profile/'package.json').write_text('{"name":"phone","dsh":{"profile":{"bundles":[]}}}')
    ofm=profile/'node_modules/dsh-our-free-model';ofm.mkdir(parents=True);(ofm/'package.json').write_text('{"name":"dsh-our-free-model","version":"2.1.0"}')
    shutil.copytree(tree/'node_modules/dsh-peer',profile/'node_modules/dsh-peer');(home/'settings.yaml').write_text('')
    for name,source in [('dsh-tree.tar',tree),('dsh-home.tar',home)]:
        with tarfile.open(assets/name,'w') as archive:
            for item in sorted(source.rglob('*')):archive.add(item,arcname=str(item.relative_to(source)),recursive=False)
    (assets/'fixture-server.mjs').write_text("import {marker} from './marker.mjs';\nimport readline from 'node:readline';\nfor await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);let result;if(q.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};else if(q.method==='tools/list')result={tools:['generate_image','generate_video','generate_audio'].map(name=>({name,inputSchema:{type:'object'}}))};else result={content:[{type:'text',text:marker}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}\n")
    (project/'app/src/main/AndroidManifest.xml').write_text(f'<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.INTERNET"/><application android:allowBackup="false" android:extractNativeLibs="true"/><instrumentation android:name="com.dshphone.McpUpgradeInstrumentation" android:targetPackage="{package}"/></manifest>')
    result={'package':package,'productionPackageTouched':False,'beforeRunnerSha256':hashlib.sha256(Path(args.before_runner).read_bytes()).hexdigest(),'afterRunnerSha256':hashlib.sha256((ROOT/'app/src/main/java/com/dshphone/NodeRunner.kt').read_bytes()).hexdigest()}
    installed=False
    try:
        existing=subprocess.run([*base,'shell','pm','path',package],capture_output=True,text=True)
        assert existing.returncode in (0,1) and not existing.stdout.strip(), 'Refusing to replace an existing app'
        for phase,code in [('before',1),('after',2)]:
            shutil.copy2(Path(args.before_runner) if phase=='before' else ROOT/'app/src/main/java/com/dshphone/NodeRunner.kt',sources/'NodeRunner.kt')
            (project/'app/build.gradle').write_text(f"""plugins {{ id 'com.android.application' }}
android {{namespace 'com.dshphone';compileSdk 36
defaultConfig {{applicationId '{package}';minSdk 28;targetSdk 36;versionCode {code};versionName '{phase}';ndk {{abiFilters 'arm64-v8a'}}}}
packaging {{jniLibs {{useLegacyPackaging=true}}}}
compileOptions {{sourceCompatibility JavaVersion.VERSION_17;targetCompatibility JavaVersion.VERSION_17}}
}}
dependencies {{implementation 'dev.rikka.shizuku:api:13.1.5';implementation 'dev.rikka.shizuku:provider:13.1.5'}}
""")
            with (output/(phase+'-build.log')).open('w') as log:subprocess.run([str(ROOT/'gradlew'),'--offline','--no-daemon',':app:clean',':app:assembleDebug'],cwd=project,env=os.environ.copy(),stdout=log,stderr=subprocess.STDOUT,check=True)
            subprocess.run([*base,'install','-r',str(project/'app/build/outputs/apk/debug/app-debug.apk')],capture_output=True,check=True);installed=True
            test=subprocess.run([*base,'shell','am','instrument','-w','-r','-e','phase',phase,package+'/com.dshphone.McpUpgradeInstrumentation'],capture_output=True,text=True,timeout=120,check=True)
            (output/(phase+'-device.log')).write_text(test.stdout+test.stderr)
            result[phase+'Passed']=f'DSH_MCP_UPGRADE_{phase.upper()}_OK' in test.stdout and 'INSTRUMENTATION_CODE: -1' in test.stdout
            if phase=='after':
                result['staleLoaderPathReproduced']='REPRODUCED_STALE_LD_LIBRARY_PATH' in test.stdout
                result['newerIndependentPluginPreserved']='PRESERVED_NEWER_INDEPENDENT_PLUGIN' in test.stdout
                assert result['newerIndependentPluginPreserved'],test.stdout
            assert result[phase+'Passed'],test.stdout
    finally:
        if installed:result['temporaryApplicationRemoved']='Success' in subprocess.check_output([*base,'uninstall',package],text=True)
        (output/'android-verification.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result))
if __name__=='__main__':main()
