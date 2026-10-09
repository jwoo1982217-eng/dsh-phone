#!/usr/bin/env python3
"""Prepare a verified ARM64 QQ package without executing its installer scripts.

The fallback is the QQ layer from the image published by NapNeko/NapCat-Docker:
https://github.com/NapNeko/NapCat-Docker
Pinned ARM64 manifest: sha256:fbb892ec4bf3f922e0df79e65fe1192ddc55be638474819aeedb0a619bbe3ba5
Only opt/QQ is copied; neither Docker nor the image entrypoint is run.
"""
import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path, PurePosixPath

CONFIG_URL = 'https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js'
REPOSITORY = 'mlikiowa/napcat-docker'
LAYER_SHA256 = 'e55912f4878f4259043a43cb88c103680084456c633cba8ae15dec49ee1d1cfe'
LAYER_SIZE = 276066037
MAX_DOWNLOAD = 512 * 1024 * 1024
MAX_EXPANDED = 2 * 1024 * 1024 * 1024


def download(url, target, *, headers=None, digest=None, size=None):
    if not url.startswith('https://'):
        raise ValueError('下载地址必须使用 HTTPS')
    temporary = target.with_suffix(target.suffix + '.part')
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'DSH-Phone-QQ/1', **(headers or {})})
            total, checksum, reported = 0, hashlib.sha256(), -1
            with urllib.request.urlopen(request, timeout=60) as response, temporary.open('wb') as output:
                if response.status != 200 or not response.url.startswith('https://'):
                    raise ValueError('下载服务器未返回有效文件')
                expected = int(response.headers.get('Content-Length', 0))
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_DOWNLOAD:
                        raise ValueError('安装包超过大小限制')
                    output.write(chunk)
                    checksum.update(chunk)
                    progress = total * 10 // (size or expected or MAX_DOWNLOAD)
                    if total > 10 * 1024 * 1024 and progress != reported:
                        reported = progress
                        print('QQ 资源下载：%d MB' % (total // (1024 * 1024)), flush=True)
            if expected and expected != total:
                raise ValueError('安装包下载不完整')
            if size is not None and total != size:
                raise ValueError('备用资源大小校验失败')
            if digest is not None and checksum.hexdigest() != digest:
                raise ValueError('备用资源 SHA256 校验失败')
            temporary.replace(target)
            return
        except Exception:
            temporary.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(2)


def official_url(config):
    # Parse data only: never evaluate the website's JavaScript.
    match = re.search(r'var\s+params\s*=\s*(\{.*\})\s*;', config, re.S)
    if not match:
        raise ValueError('QQ 官网下载配置无法读取')
    url = json.loads(match.group(1))['armDownloadUrl']['deb']
    if not re.fullmatch(r'https://(?:qqdl\.gtimg\.cn|dldir1(?:v6)?\.qq\.com)/qqfile/[A-Za-z0-9_./-]+\.deb', url):
        raise ValueError('QQ 官网返回了未知下载地址')
    return url


def check_qq_files(root):
    binary = root / 'opt/QQ/qq'
    package = root / 'opt/QQ/resources/app/package.json'
    with binary.open('rb') as stream:
        header = stream.read(20)
    if len(header) != 20 or header[:6] != b'\x7fELF\x02\x01' or struct.unpack('<H', header[18:20])[0] != 183:
        raise ValueError('QQ 程序不是适合手机的 ARM64 文件')
    version = json.loads(package.read_text())['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+-\d+', version) or int(version.rsplit('-', 1)[1]) < 40768:
        raise ValueError('QQ 版本无法用于当前 NapCat')
    return version


def extract_qq_files(source, destination):
    """Use Python's data filter; skip directory chown/chmod under Android PRoot."""
    expanded, count = 0, 0
    for member in source:
        parts = PurePosixPath(member.name).parts
        if parts[:2] != ('opt', 'QQ'):
            continue
        expanded += member.size
        count += 1
        if expanded > MAX_EXPANDED or count > 20000:
            raise ValueError('QQ 解压资源超过限制')
        if '..' in parts or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise ValueError('QQ 资源包含无效路径或文件')
        source.extract(member, destination, filter='data')
    version = check_qq_files(destination)
    (destination / 'opt/QQ/qq').chmod(0o755)
    return version


def extract_qq_layer(archive, destination):
    with tarfile.open(archive, 'r|gz') as source:
        return extract_qq_files(source, destination)


def validate_deb(package, destination):
    subprocess.run(['dpkg-deb', '--info', str(package)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    arch = subprocess.check_output(['dpkg-deb', '--field', str(package), 'Architecture'], text=True).strip()
    if arch != 'arm64':
        raise ValueError('QQ 安装包架构不匹配')
    # dpkg -x invokes GNU tar, whose directory permission restoration fails in
    # some phone PRoot environments. Read the data stream and use the same
    # bounded, path-checked Python extractor as the verified fallback layer.
    process = subprocess.Popen(['dpkg-deb', '--fsys-tarfile', str(package)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        with tarfile.open(fileobj=process.stdout, mode='r|') as source:
            version = extract_qq_files(source, destination)
        if process.wait(timeout=120) != 0:
            raise ValueError('QQ 安装包数据读取失败')
        return version
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def fallback_package(work):
    print('官网暂时无法下载，正在使用 NapCat 官方 ARM64 备用资源。', flush=True)
    token_request = urllib.request.Request('https://auth.docker.io/token?service=registry.docker.io&scope=repository:' + REPOSITORY + ':pull')
    with urllib.request.urlopen(token_request, timeout=60) as response:
        token = json.load(response)['token']
    archive = work / 'qq-layer.tar.gz'
    download('https://registry-1.docker.io/v2/' + REPOSITORY + '/blobs/sha256:' + LAYER_SHA256,
             archive, headers={'Authorization': 'Bearer ' + token, 'Accept-Encoding': 'identity'}, digest=LAYER_SHA256, size=LAYER_SIZE)
    root = work / 'qq-fallback'
    root.mkdir()
    version = extract_qq_layer(archive, root)
    control = root / 'DEBIAN'
    control.mkdir()
    control.chmod(0o755)  # The outer installer uses umask 077; dpkg requires 0755.
    (control / 'control').write_text('Package: linuxqq\nVersion: ' + version + '\nArchitecture: arm64\nMaintainer: DSH Phone <noreply@example.invalid>\nDescription: QQ runtime from the official NapCat ARM64 image\n')
    package = work / 'QQ.deb'
    subprocess.run(['dpkg-deb', '--build', '--root-owner-group', '-Zgzip', str(root), str(package)], check=True)
    checked = validate_deb(package, work / 'qq-verified')
    if checked != version:
        raise ValueError('QQ 安装包版本校验失败')
    archive.unlink()
    shutil.rmtree(root)
    return version


def prepare(work):
    print('正在获取并校验 QQ 手机安装资源。', flush=True)
    if subprocess.check_output(['dpkg', '--print-architecture'], text=True).strip() != 'arm64':
        raise ValueError('此手机版安装入口仅支持 ARM64')
    package, staging = work / 'QQ.deb', work / 'qq-verified'
    try:
        config = work / 'linuxConfig.js'
        download(CONFIG_URL, config)
        download(official_url(config.read_text()), package)
        version = validate_deb(package, staging)
    except Exception as error:
        # Error text may contain a registry token; report only the error class.
        print('官网资源未通过下载或文件校验（%s），正在切换备用来源。' % type(error).__name__, flush=True)
        package.unlink(missing_ok=True)
        if staging.exists():
            shutil.rmtree(staging)
        version = fallback_package(work)
    shutil.rmtree(staging)
    (work / 'qq-version.txt').write_text(version)
    print('QQ 安装包校验通过，版本：' + version, flush=True)
    return version


if __name__ == '__main__':
    try:
        if len(sys.argv) == 4 and sys.argv[1] == '--extract-deb':
            version = validate_deb(Path(sys.argv[2]), Path(sys.argv[3]))
            print('QQ 文件解压校验通过，版本：' + version, flush=True)
        elif len(sys.argv) == 1:
            prepare(Path.cwd())
        else:
            raise ValueError('QQ 资源准备参数无效')
    except Exception as error:
        raise SystemExit('QQ 资源准备失败（%s）。原来的手机 QQ 环境已保留，请把此页面发给维护者。' % type(error).__name__)
