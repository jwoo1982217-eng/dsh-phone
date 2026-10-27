"""Reproduce native-only control maintenance from verified assets122; exclude SDK WIP."""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE_SHA = '695ea2b6de8f68eb4546e491804b8f203fa394f05740896b3bbae994985af4d2'
BASE_COMMIT = '6874bc9aee6b3a767c85dbe5cea4af474ac37ddb'

def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def prepare(base_apk, project, owner):
    project, base_apk = Path(project).resolve(), Path(base_apk).resolve()
    maintenance = load('control_compaction_source', 'scripts/prepare-compaction-apk.py')
    maintenance.validate_project_task(project, owner=owner)
    if sha(base_apk) != BASE_SHA:
        raise ValueError('Unknown base APK; existing project and device remain untouched')
    if project.exists() and any(project.iterdir()):
        raise ValueError('Refuse to overwrite existing prepared source')
    paths = ['app/src', 'app/build.gradle', 'build.gradle', 'settings.gradle', 'gradle.properties', 'gradlew', 'gradle', 'scripts/verify-pocket-apk.py']
    paths = [p for p in paths if subprocess.run(['git', 'cat-file', '-e', BASE_COMMIT + ':' + p], cwd=ROOT, capture_output=True).returncode == 0]
    archive = subprocess.check_output(['git', 'archive', BASE_COMMIT, *paths], cwd=ROOT)
    project.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        source.extractall(project, filter='data')
    os.chmod(project / 'gradlew', 0o755)
    (project / 'local.properties').write_text('sdk.dir=/Users/example/Library/Android/sdk\n')
    with zipfile.ZipFile(base_apk) as apk:
        for name in apk.namelist():
            target = None
            if name.startswith('assets/') and not name.endswith('/'):
                target = project / 'app/src/main' / name
            elif name.startswith('lib/arm64-v8a/') and not name.endswith('/'):
                target = project / 'app/src/main/jniLibs/arm64-v8a' / name.split('/')[-1]
            if target is not None:
                target.parent.mkdir(parents=True, exist_ok=True)
                with apk.open(name) as src, target.open('wb') as dst:
                    shutil.copyfileobj(src, dst)
    for name in ['PhoneJetHubAlias.kt', 'PhoneJetHubUpgrade.kt', 'BundledPackageUpgrade.kt', 'PhoneCompactionUpgrade.kt', 'LegacyCompactionFiles.kt']:
        shutil.copy2(ROOT / 'app/src/main/java/com/dshphone' / name, project / 'app/src/main/java/com/dshphone' / name)
    runner = project / 'app/src/main/java/com/dshphone/NodeRunner.kt'
    replace = maintenance.replace_once
    text = replace(runner.read_text(), '        RecoveryManager.recoverInterruptedRestore(ctx)', '        RecoveryManager.recoverInterruptedRestore(ctx)\n        PhoneJetHubUpgrade.recover(ctx.filesDir)\n        PhoneCompactionUpgrade.recover(ctx.filesDir)')
    text = replace(text, '    private fun extractAsset(ctx: Context', '    internal fun extractAsset(ctx: Context')
    text = replace(text, 'ASSET_VERSION = "117"', 'ASSET_VERSION = "121"')
    text = replace(text, 'if (alreadyOk) return', 'if (alreadyOk) { PhoneJetHubAlias.prepare(ctx.filesDir); return }\n        PhoneJetHubAlias.preflight(ctx.filesDir)\n        if (PhoneCompactionUpgrade.applyIfSupported(ctx, ASSET_VERSION)) return\n        if (PhoneJetHubUpgrade.applyIfSupported(ctx, ASSET_VERSION)) return')
    text = replace(text, '        makeHomeLink(ctx)\n        versionFile(ctx).writeText(ASSET_VERSION)', '        PhoneJetHubAlias.prepare(ctx.filesDir)\n        makeHomeLink(ctx)\n        versionFile(ctx).writeText(ASSET_VERSION)')
    runner.write_text(text)
    gradle = project / 'app/build.gradle'
    gradle.write_text(replace(replace(gradle.read_text(), 'versionCode 117', 'versionCode 121'), 'versionName "0.2.12"', 'versionName "0.2.16"'))
    remote = load('control_peer_source', 'scripts/prepare-remote-apk.py')
    remote.native_inputs(project)
    delta = apply_control(project, maintenance)
    result = {'baseCommit': BASE_COMMIT, 'baseApkSha256': BASE_SHA, 'resourceVersion': '122', 'sdk': '0.2.1-alpha.1', 'nativeSource': 'verified stable122 + own-app control setup', 'versionCode': 123, 'versionName': '0.2.18', 'delta': delta}
    (project / 'control-source.json').write_text(json.dumps(result, indent=2) + '\n')
    return result

def apply_control(project, maintenance=None):
    project = Path(project).resolve()
    maintenance = maintenance or load('control_compaction_delta', 'scripts/prepare-compaction-apk.py')
    maintenance.validate_project_task(project)
    activity = Path('app/src/main/java/com/dshphone/control/ControlActivity.kt')
    if sha(project / activity) != '74dd46f761bc79bab0c0eb5f5ef33d03fdcddb603d12896c092dd37c67b0c1c4':
        raise ValueError('Unknown stable control Activity; preserve existing source')
    names = [str(activity)] + ['app/src/main/java/com/dshphone/control/' + n for n in ['ControlSetup.kt', 'ControlRepairService.kt', 'ControlRepair.kt']]
    names += ['app/src/test/java/com/dshphone/control/ControlSetupTest.kt']
    runtime = 'app/src/main/java/com/dshphone/control/ControlRuntime.kt'
    original = (project / runtime).read_text()
    canonical = (ROOT / runtime).read_text()
    start = canonical.index('                                val currentService = service\n')
    end_marker = '                                } else error("无障碍通道未连接；聊天权限保持不变，请到服务→手机操作点“开启并检查”")'
    end = canonical.index(end_marker, start) + len(end_marker)
    old = '''                            (service ?: error("请在系统设置启用 DSH 手机操作无障碍服务")).execute(owner, grant.epoch, payload.getJSONObject("args"), false) { result ->
                                executions.remove(key)
                                if (future.isDone) return@execute
                                remember(key, result); if (lease.current()?.epoch == grant.epoch) lastResult = result; future.complete(result)
                            }'''
    finish = '''                            val finish: (org.json.JSONObject) -> Unit = { result ->
                                executions.remove(key)
                                if (!future.isDone) {
                                    remember(key, result); if (lease.current()?.epoch == grant.epoch) lastResult = result; future.complete(result)
                                }
                            }
'''
    patched = maintenance.replace_once(original, old, finish + '\n'.join(line[4:] for line in canonical[start:end].splitlines()))
    status_end = '.put("lastResult", if (owner.isEmpty() || owner == grant?.owner) lastResult else JSONObject.NULL)'
    patched = maintenance.replace_once(patched, status_end, status_end + '\n            .also { ControlSetup.addReadiness(it, context ?: error("手机操作尚未启动")) }')
    # Validate every old checkpoint before writing any new delta.
    gradle = project / 'app/build.gradle'
    updated_gradle = maintenance.replace_once(maintenance.replace_once(gradle.read_text(), 'versionCode 122', 'versionCode 123'), 'versionName "0.2.17"', 'versionName "0.2.18"')
    for name in names:
        target = project / name; target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(ROOT / name, target)
    (project / runtime).write_text(patched)
    gradle.write_text(updated_gradle)
    return {name: sha(project / name) for name in [*names, runtime, 'app/build.gradle']}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-apk', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--owner', required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.base_apk, args.project, args.owner)))
