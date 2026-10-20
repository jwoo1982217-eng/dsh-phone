#!/usr/bin/env python3
"""按固定哈希准备官方 OpenCode 及 Android 加载器；不执行包安装脚本。"""
from pathlib import Path
import argparse
import hashlib
import io
import json
import os
import tarfile
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]


def atomic(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_bytes(data)
    temporary.chmod(mode)
    os.replace(temporary, path)


def prepare(target, cache):
    manifest = json.loads((ROOT / 'native/opencode-runtime.json').read_text())
    receipt = []
    cache.mkdir(parents=True, exist_ok=True)
    for item in manifest['targets'][target]:
        destination = ROOT / item['destination']
        if not destination.resolve().is_relative_to(ROOT.resolve()):
            raise RuntimeError('原生组件目标路径越界')
        if destination.is_file() and hashlib.sha256(destination.read_bytes()).hexdigest() == item['binarySha256']:
            receipt.append({'file': item['destination'], 'bytes': destination.stat().st_size, 'sha256': item['binarySha256']})
            continue
        path = cache / (item['sha256'] + '.archive')
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
            raise RuntimeError('缓存校验失败，保留原安装文件：' + item['package'])
        if not path.exists():
            with urllib.request.urlopen(item['url'], timeout=120) as response:
                archive = response.read()
            if hashlib.sha256(archive).hexdigest() != item['sha256']:
                raise RuntimeError('下载校验失败，保留原安装文件：' + item['package'])
            atomic(path, archive)
        with tarfile.open(fileobj=io.BytesIO(path.read_bytes()), mode='r:gz', ignore_zeros=True) as archive:
            member = archive.getmember(item['member'])
            if not member.isfile():
                raise RuntimeError('原生组件不是普通文件')
            binary = archive.extractfile(member).read()
        if hashlib.sha256(binary).hexdigest() != item['binarySha256']:
            raise RuntimeError('原生组件校验失败：' + item['package'])
        atomic(destination, binary, 0o755)
        receipt.append({'file': item['destination'], 'bytes': len(binary), 'sha256': item['binarySha256']})
    license_root = ROOT / 'native/opencode-licenses'
    sources = json.loads((license_root / 'sources.json').read_text())
    notices = ['OpenCode 1.19.2 本地服务运行组件\n官方来源与许可证；原始 ELF/Mach-O 未修改。\n']
    for item in sources:
        data = (license_root / item['name']).read_bytes()
        if hashlib.sha256(data).hexdigest() != item['sha256']:
            raise RuntimeError('许可证校验失败：' + item['name'])
        notices.append('\n' + item['name'] + '\n' + item['url'] + '\n\n' + data.decode())
    notice_file = ROOT / ('app/src/main/assets/opencode-notices.txt' if target == 'android-arm64' else 'native/opencode/darwin-arm64/OPENCODE-NOTICES.txt')
    atomic(notice_file, '\n'.join(notices).encode())
    record = {'version': manifest['version'], 'target': target, 'verified': receipt}
    atomic(ROOT / ('native/opencode/' + target + '/receipt.json'), json.dumps(record, ensure_ascii=False, indent=2).encode())
    return record


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True, choices=['darwin-arm64', 'android-arm64'])
    parser.add_argument('--cache-dir', type=Path, default=ROOT / 'native/.opencode-cache')
    args = parser.parse_args()
    print(json.dumps(prepare(args.target, args.cache_dir), ensure_ascii=False))
