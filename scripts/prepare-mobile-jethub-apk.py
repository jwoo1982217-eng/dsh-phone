"""从稳定Android源码和验证过的117资源构建独立JetHub发行线。"""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE_COMMIT = '6874bc9aee6b3a767c85dbe5cea4af474ac37ddb'
VERSION_CODE = 119


def prepare(base_apk, project):
    spec = importlib.util.spec_from_file_location('resources', ROOT/'scripts/mobile-jethub-release.py')
    resources = importlib.util.module_from_spec(spec); spec.loader.exec_module(resources)
    base_apk, project = Path(base_apk).resolve(), Path(project).resolve()
    if resources.digest(base_apk) != resources.BASE_APK_SHA256:
        raise ValueError('拒绝未知基础APK')
    if project == ROOT or ROOT in project.parents:
        raise ValueError('请使用已登记任务generated目录中的隔离Android目录')
    tasks=[p for p in project.parents if (p/'.task-artifacts.json').is_file()]
    if not tasks or not project.is_relative_to(tasks[0]/'generated'):
        raise ValueError('必须使用已登记任务的generated目录')
    task=json.loads((tasks[0]/'.task-artifacts.json').read_text())
    if task.get('status')!='open' or Path(task['source']).resolve()!=ROOT:
        raise ValueError('任务必须处于打开状态并属于本规范工程')
    if (project/'app/src/main/java/com/dshphone/JetHubUpgradeInstrumentation.kt').exists():
        raise ValueError('请先收尾本任务测试输入，禁止将测试应用混入正式包')
    paths=['app/src','app/build.gradle','build.gradle','settings.gradle','gradle.properties','gradlew','gradle','scripts/verify-pocket-apk.py']
    paths=[p for p in paths if subprocess.run(['git','cat-file','-e',BASE_COMMIT+':'+p],cwd=ROOT,capture_output=True).returncode==0]
    data=subprocess.check_output(['git','archive',BASE_COMMIT,*paths],cwd=ROOT)
    project.mkdir(parents=True,exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:tar.extractall(project,filter='data')
    if not (project/'gradlew').exists():shutil.copy2(ROOT/'gradlew',project/'gradlew')
    os.chmod(project/'gradlew',0o755)
    (project/'local.properties').write_text('sdk.dir='+os.environ.get('ANDROID_HOME','/Users/example/Downloads/AndroidDev/Android/sdk')+'\n')
    with zipfile.ZipFile(base_apk) as apk:
        for name in apk.namelist():
            target=None
            if name.startswith('assets/') and not name.endswith('/'):target=project/'app/src/main'/name
            if name.startswith('lib/arm64-v8a/') and not name.endswith('/'):target=project/'app/src/main/jniLibs/arm64-v8a'/name.split('/')[-1]
            if target:target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(apk.read(name))
    for name in ['PhoneJetHubAlias.kt','PhoneJetHubUpgrade.kt','BundledPackageUpgrade.kt']:
        shutil.copy2(ROOT/'app/src/main/java/com/dshphone'/name,project/'app/src/main/java/com/dshphone'/name)
    shutil.copy2(ROOT/'app/src/test/java/com/dshphone/BundledPackageUpgradeTest.kt',project/'app/src/test/java/com/dshphone/BundledPackageUpgradeTest.kt')
    runner=project/'app/src/main/java/com/dshphone/NodeRunner.kt'
    source=runner.read_text().replace('        RecoveryManager.recoverInterruptedRestore(ctx)', '        RecoveryManager.recoverInterruptedRestore(ctx)\n        PhoneJetHubUpgrade.recover(ctx.filesDir)',1).replace('    private fun extractAsset(ctx: Context','    internal fun extractAsset(ctx: Context',1).replace('ASSET_VERSION = "117"','ASSET_VERSION = "119"')
    source=source.replace('if (alreadyOk) return','if (alreadyOk) { PhoneJetHubAlias.prepare(ctx.filesDir); return }\n        PhoneJetHubAlias.preflight(ctx.filesDir)\n        if (PhoneJetHubUpgrade.applyIfSupported(ctx, ASSET_VERSION)) return',1)
    source=source.replace('        makeHomeLink(ctx)\n        versionFile(ctx).writeText(ASSET_VERSION)','        PhoneJetHubAlias.prepare(ctx.filesDir)\n        makeHomeLink(ctx)\n        versionFile(ctx).writeText(ASSET_VERSION)',1)
    runner.write_text(source)
    gradle=project/'app/build.gradle'
    gradle.write_text(gradle.read_text().replace('versionCode 117','versionCode 119').replace('versionName "0.2.12"','versionName "0.2.14"'))
    # 资源单独生成；可复用经SHA匹配的已生成配套归档，不复制完整工程或依赖。
    result={'baseCommit':BASE_COMMIT,'baseApkSha256':resources.BASE_APK_SHA256,'versionCode':VERSION_CODE,
            'versionName':'0.2.14','sdk':'0.2.1-alpha.1','jetHubSource':'vendor/dsh-codearts-auth'}
    (project/'mobile-jethub-source.json').write_text(json.dumps(result,indent=2)+'\n')
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-apk',required=True);parser.add_argument('--project',required=True)
    args=parser.parse_args();print(json.dumps(prepare(args.base_apk,args.project)))
