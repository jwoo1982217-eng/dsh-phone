"""仅更新已验证117发行资源中的JetHub；不混入工作树里未完成的核心升级。"""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import shutil
import tarfile
import zipfile

BASE_APK_SHA256 = '6a5599eee1bfbde8059a49ac08613e8be28783f042c9cd87187b0c0bbd3bcdcb'


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        while data := f.read(1024 * 1024):
            h.update(data)
    return h.hexdigest()


def safe_child(root, name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('运行资源路径越界')
    return root.joinpath(*path.parts)


def extract_tar(source, target):
    with tarfile.open(fileobj=source, mode='r|') as tar:
        for member in tar:
            safe_child(target, member.name)
            if not (member.isfile() or member.isdir()):
                raise ValueError('发行资源不能包含链接或设备文件')
            tar.extract(member, target, filter='data')


def hydrate(tree, home):
    manifest = home / '.shared-runtime-files.json'
    rows = json.loads(manifest.read_text())
    if rows['version'] != 1:
        raise ValueError('未知共享清单格式')
    # 全部先校验，再写副本；等长变更也不得漏过。
    prepared = []
    for row in rows['files']:
        if not row['source'].startswith('node_modules/') or not row['target'].startswith('profiles/phone/node_modules/'):
            raise ValueError('共享清单引用范围错误')
        source = safe_child(tree, row['source'])
        target = safe_child(home, row['target'])
        if not source.is_file() or source.stat().st_size != row['bytes'] or digest(source) != row['sha256']:
            raise ValueError('共享资源大小或SHA不匹配: ' + row['source'])
        if target.exists():
            raise ValueError('共享资源目标冲突')
        prepared.append((source, target))
    for source, target in prepared:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    manifest.unlink()
    return len(prepared)


def deduplicate(tree, home):
    modules = home / 'profiles/phone/node_modules'
    rows = []
    for target in sorted(modules.rglob('*')):
        if not target.is_file():
            continue
        source = tree / 'node_modules' / target.relative_to(modules)
        if source.is_file() and source.stat().st_size == target.stat().st_size and digest(source) == digest(target):
            rows.append({'source': source.relative_to(tree).as_posix(),
                         'target': target.relative_to(home).as_posix(),
                         'bytes': source.stat().st_size, 'sha256': digest(source)})
    for row in rows:
        safe_child(home, row['target']).unlink()
    (home / '.shared-runtime-files.json').write_text(json.dumps({'version': 1, 'files': rows}, separators=(',', ':')) + '\n')
    return rows


def package_hub(source, target):
    manifest = json.loads((source / 'package.json').read_text())
    if manifest['name'] != 'dsh-providers-hub' or manifest['version'] != '0.2.1-rc.2':
        raise ValueError('必须使用已审阅的电脑版JetHub版本')
    if not (source / 'lib/index.js').is_file() or not (source / 'lib/client/jet-hub.js').is_file():
        raise ValueError('JetHub两侧编译产物缺失')
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    shutil.copy2(source / 'package.json', target / 'package.json')
    for entry in ['lib', 'locale', 'cordis.patch.yml']:
        item = source / entry
        if item.is_dir():
            shutil.copytree(item, target / entry)
        else:
            shutil.copy2(item, target / entry)
    return manifest


def make_tar(source, destination):
    temporary = destination.with_suffix('.new.tar')
    def clean(member):
        member.uid = member.gid = 0
        member.uname = member.gname = ''
        member.pax_headers = {}
        member.mtime = 0
        return member
    try:
        with tarfile.open(temporary, 'w') as tar:
            for path in sorted(source.rglob('*')):
                if path.is_symlink():
                    raise ValueError('资源别名须由原生启动器创建，归档不接受链接')
                tar.add(path, arcname=path.relative_to(source).as_posix(), recursive=False, filter=clean)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def build(base_apk, hub_source, stage, output):
    base_apk, hub_source, stage, output = map(Path, [base_apk, hub_source, stage, output])
    if digest(base_apk) != BASE_APK_SHA256:
        raise ValueError('基础APK不是已验证的117恢复包；输入保持')
    if stage.exists() and any(stage.iterdir()):
        raise ValueError('复用已准备的暂存目录，禁止覆盖未知内容')
    stage.mkdir(parents=True, exist_ok=True)
    tree, home = stage / 'tree', stage / 'home'
    tree.mkdir(); home.mkdir()
    with zipfile.ZipFile(base_apk) as apk:
        extract_tar(apk.open('assets/dsh-tree.tar'), tree)
        extract_tar(apk.open('assets/dsh-home.tar'), home)
    hydrated = hydrate(tree, home)
    core = json.loads((tree / 'node_modules/@deepseek-ai/dsh/package.json').read_text())['version']
    if core != '0.2.1-alpha.1':
        raise ValueError('禁止本次升级替换手机核心')
    # 两处均保留旧目录键，新名称由PhoneJetHubAlias连到同一实体。
    package_hub(hub_source, tree / 'node_modules/dsh-codearts-auth')
    package_hub(hub_source, home / 'profiles/phone/node_modules/dsh-codearts-auth')
    rows = deduplicate(tree, home)
    output.mkdir(parents=True, exist_ok=True)
    make_tar(tree, output / 'dsh-tree.tar')
    make_tar(home, output / 'dsh-home.tar')
    result = {'baseApkSha256': BASE_APK_SHA256, 'core': core,
              'jetHubName': 'dsh-providers-hub', 'jetHubVersion': '0.2.1-rc.2',
              'hydratedBaselineRows': hydrated, 'newSharedRows': len(rows),
              'treeSha256': digest(output / 'dsh-tree.tar'), 'homeSha256': digest(output / 'dsh-home.tar')}
    (output / 'jethub-build.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['base-apk', 'hub-source', 'stage', 'output']:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.base_apk, args.hub_source, args.stage, args.output)))
