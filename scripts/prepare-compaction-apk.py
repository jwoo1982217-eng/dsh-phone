"""Prepare the 121 compatibility maintenance APK from verified 119, excluding rc.2 WIP."""
from pathlib import Path
import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE_COMMIT = '6874bc9aee6b3a767c85dbe5cea4af474ac37ddb'
BASE_SHA = 'fb91dee13a0268766db8b56cbe7a4bfefdb17bb47f31428165cd0f611be3be50'
OLD = '524b97de30f99d816fbf81da6936ac3c2bf1a0bc27d88c8dce83d349aab924e7'
FIXED = '17da3fb22dcd7b209424b2a64894023cf54cdff4e0a37e1aae4f05c1bda99404'
RUNNER = 'node_modules/@deepseek-ai/dsh-compaction-basic/lib/summary-runner.mjs'

def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError('Stable source checkpoint changed: '+old[:90])
    return text.replace(old, new, 1)

def validate_project_task(project, *, source=ROOT, owner=None):
    project = Path(project).resolve()
    tasks = [p for p in project.parents if (p/'.task-artifacts.json').is_file()]
    if not tasks or not project.is_relative_to(tasks[0]/'generated') or project == tasks[0]/'generated':
        raise ValueError('Use this registered task generated directory')
    record = json.loads((tasks[0]/'.task-artifacts.json').read_text())
    if record['status'] != 'open' or Path(record['source']).resolve() != Path(source).resolve():
        raise ValueError('Wrong task/source owner')
    if owner is not None and record.get('owner') != owner:
        raise ValueError('Wrong task owner')
    return record

def prepare(base, project, *, task_source=ROOT, owner=None):
    base, project = Path(base).resolve(), Path(project).resolve()
    if digest(base) != BASE_SHA:
        raise ValueError('Unknown base APK; preserve current source and runtime')
    validate_project_task(project, source=task_source, owner=owner)
    if project.exists() and any(project.iterdir()):
        raise ValueError('Refuse to overwrite prepared inputs')
    paths = ['app/src', 'app/build.gradle', 'build.gradle', 'settings.gradle', 'gradle.properties', 'gradlew', 'gradle', 'scripts/verify-pocket-apk.py']
    paths = [p for p in paths if subprocess.run(['git','cat-file','-e',BASE_COMMIT+':'+p],cwd=ROOT,capture_output=True).returncode == 0]
    project.mkdir(parents=True, exist_ok=True)
    data = subprocess.check_output(['git','archive',BASE_COMMIT,*paths],cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        tar.extractall(project, filter='data')
    if not (project/'gradlew').exists():
        shutil.copy2(ROOT/'gradlew',project/'gradlew')
    os.chmod(project/'gradlew',0o755)
    (project/'local.properties').write_text('sdk.dir='+os.environ.get('ANDROID_HOME','/Users/example/Downloads/AndroidDev/Android/sdk')+'\n')
    fixed = (ROOT/'runtime/overlays/@deepseek-ai/dsh-compaction-basic/lib/summary-runner.mjs').read_bytes()
    if hashlib.sha256(fixed).hexdigest() != FIXED:
        raise ValueError('Untested compaction source')
    changes = []
    with zipfile.ZipFile(base) as apk:
        for name in apk.namelist():
            target = None
            if name.startswith('assets/') and not name.endswith('/'):
                target = project/'app/src/main'/name
            elif name.startswith('lib/arm64-v8a/') and not name.endswith('/'):
                target = project/'app/src/main/jniLibs/arm64-v8a'/name.split('/')[-1]
            if target is None:
                continue
            target.parent.mkdir(parents=True,exist_ok=True)
            if name in ('assets/dsh-tree.tar','assets/dsh-home.tar'):
                with apk.open(name) as stream, tarfile.open(fileobj=stream,mode='r|') as source, tarfile.open(target,'w') as output:
                    for member in source:
                        content = source.extractfile(member) if member.isfile() else None
                        if member.name == RUNNER or member.name.endswith('/'+RUNNER):
                            old = content.read()
                            if hashlib.sha256(old).hexdigest() != OLD:
                                raise ValueError('Unknown bundled runner')
                            member.size = len(fixed); content = io.BytesIO(fixed)
                            changes.append(name+':'+member.name)
                        elif member.name == '.shared-runtime-files.json':
                            original = content.read()
                            manifest = json.loads(original)
                            updated = False
                            for row in manifest['files']:
                                if row['source'] == RUNNER:
                                    if row['sha256'] != OLD:
                                        raise ValueError('Unknown shared runner')
                                    row.update(bytes=len(fixed),sha256=FIXED)
                                    updated = True
                                    changes.append(name+':shared:'+row['target'])
                            new = (json.dumps(manifest,separators=(',',':')).encode()+b'\n') if updated else original
                            member.size = len(new); content = io.BytesIO(new)
                        output.addfile(member,content)
            else:
                with apk.open(name) as src, target.open('wb') as dst:
                    shutil.copyfileobj(src,dst)
    if 'assets/dsh-tree.tar:'+RUNNER not in changes:
        raise ValueError('Missing bundled runner')
    (project/'app/src/main/assets/compaction-summary-runner.mjs').write_bytes(fixed)
    for name, expected in [('summary-budget.mjs','52ddd7849c119c7c7028a8b5b576e390ae438c349b59ab2d92154b93bf9ca6c8'),
                           ('summary-checkpoint.mjs','9f5909ccf1cc0ad17a49f5cb95da67b6c850dce5ea80df54d07296ebada0e275')]:
        helper = ROOT/'runtime/overlays/@deepseek-ai/dsh-compaction-basic/lib'/name
        if digest(helper) != expected:
            raise ValueError('Untested legacy compaction helper: '+name)
        shutil.copy2(helper,project/'app/src/main/assets'/('compaction-'+name))
    for name in ['PhoneJetHubAlias.kt','PhoneJetHubUpgrade.kt','BundledPackageUpgrade.kt','PhoneCompactionUpgrade.kt','LegacyCompactionFiles.kt']:
        shutil.copy2(ROOT/'app/src/main/java/com/dshphone'/name,project/'app/src/main/java/com/dshphone'/name)
    shutil.copy2(ROOT/'app/src/test/java/com/dshphone/BundledPackageUpgradeTest.kt',project/'app/src/test/java/com/dshphone/BundledPackageUpgradeTest.kt')
    runner = project/'app/src/main/java/com/dshphone/NodeRunner.kt'
    s = runner.read_text()
    s = replace_once(s,'        RecoveryManager.recoverInterruptedRestore(ctx)',
        '        RecoveryManager.recoverInterruptedRestore(ctx)\n        PhoneJetHubUpgrade.recover(ctx.filesDir)\n        PhoneCompactionUpgrade.recover(ctx.filesDir)')
    s = replace_once(s,'    private fun extractAsset(ctx: Context','    internal fun extractAsset(ctx: Context')
    s = replace_once(s,'ASSET_VERSION = "117"','ASSET_VERSION = "121"')
    s = replace_once(s,'if (alreadyOk) return',
        'if (alreadyOk) { PhoneJetHubAlias.prepare(ctx.filesDir); return }\n        PhoneJetHubAlias.preflight(ctx.filesDir)\n        if (PhoneCompactionUpgrade.applyIfSupported(ctx, ASSET_VERSION)) return\n        if (PhoneJetHubUpgrade.applyIfSupported(ctx, ASSET_VERSION)) return')
    s = replace_once(s,'        makeHomeLink(ctx)\n        versionFile(ctx).writeText(ASSET_VERSION)',
        '        PhoneJetHubAlias.prepare(ctx.filesDir)\n        makeHomeLink(ctx)\n        versionFile(ctx).writeText(ASSET_VERSION)')
    runner.write_text(s)
    gradle = project/'app/build.gradle'
    s = replace_once(gradle.read_text(),'versionCode 117','versionCode 121')
    gradle.write_text(replace_once(s,'versionName "0.2.12"','versionName "0.2.16"'))
    result = dict(baseCommit=BASE_COMMIT,baseApkSha256=BASE_SHA,versionCode=121,versionName='0.2.16',assetVersion='121',sdk='0.2.1-alpha.1',runnerSha256=FIXED,resourceChanges=changes)
    (project/'compaction-source.json').write_text(json.dumps(result,indent=2)+'\n')
    return result

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-apk',required=True); parser.add_argument('--project',required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.base_apk,args.project)))
