import hashlib
import importlib.util
import io
import json
import gzip
import os
import struct
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location('qq_download', Path(__file__).with_name('qq-download.py'))
qq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qq)


class Response(io.BytesIO):
    status, url = 200, 'https://example.test/qq'

    def __init__(self, body, length=None):
        super().__init__(body)
        self.headers = {'Content-Length': str(length if length is not None else len(body))}


class DownloadTests(unittest.TestCase):
    def test_http_404_is_never_published_as_a_package(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(qq.time, 'sleep'), patch.object(qq.urllib.request, 'urlopen', side_effect=HTTPError('https://example.test', 404, 'Not Found', {}, None)):
            target = Path(tmp) / 'QQ.deb'
            with self.assertRaises(HTTPError):
                qq.download('https://example.test/qq', target)
            self.assertFalse(target.exists())
            self.assertFalse(target.with_suffix('.deb.part').exists())

    def test_truncated_or_bad_hash_downloads_are_rejected(self):
        for settings in [{'size': 10}, {'digest': '0' * 64}]:
            with self.subTest(settings=settings), tempfile.TemporaryDirectory() as tmp, patch.object(qq.time, 'sleep'), patch.object(qq.urllib.request, 'urlopen', side_effect=lambda *a, **k: Response(b'file')):
                target = Path(tmp) / 'QQ.deb'
                with self.assertRaises(ValueError):
                    qq.download('https://example.test/qq', target, **settings)
                self.assertFalse(target.exists())

    def test_valid_hash_and_size_publish_atomically(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(qq.urllib.request, 'urlopen', return_value=Response(b'file')):
            target = Path(tmp) / 'QQ.deb'
            qq.download('https://example.test/qq', target, size=4, digest=hashlib.sha256(b'file').hexdigest())
            self.assertEqual(target.read_bytes(), b'file')

    def test_website_javascript_is_parsed_as_data_with_official_host_validation(self):
        valid = 'https://qqdl.gtimg.cn/qqfile/QQNT/QQ_arm64.deb'
        self.assertEqual(qq.official_url(';(function(){var params= ' + json.dumps({'armDownloadUrl': {'deb': valid}}) + ';})()'), valid)
        for invalid in ['https://other.test/qq.deb', 'https://qqdl.gtimg.cn.evil.test/qqfile/qq.deb', 'http://qqdl.gtimg.cn/qqfile/QQ.deb']:
            with self.assertRaises(ValueError):
                qq.official_url('var params=' + json.dumps({'armDownloadUrl': {'deb': invalid}}) + ';')

    def archive(self, root, extra=None, machine=183):
        path = root / 'layer.tar.gz'
        header = bytearray(20)
        header[:6] = b'\x7fELF\x02\x01'
        struct.pack_into('<H', header, 18, machine)
        entries = [('opt/QQ/qq', bytes(header)), ('opt/QQ/resources/app/package.json', b'{"version":"3.2.30-50969"}'), ('etc/ignore.txt', b'not QQ')]
        with tarfile.open(path, 'w:gz') as tar:
            for name, data in entries:
                member = tarfile.TarInfo(name)
                member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
            if extra:
                tar.addfile(extra)
        return path

    def test_layer_copies_only_qq_and_verifies_native_architecture(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            destination = root / 'staging'
            self.assertEqual(qq.extract_qq_layer(self.archive(root), destination), '3.2.30-50969')
            self.assertFalse((destination / 'etc').exists())
            with self.assertRaises(ValueError):
                qq.extract_qq_layer(self.archive(root, machine=62), root / 'wrong-arch')

    def test_layer_rejects_escaping_paths_and_links(self):
        for member in [tarfile.TarInfo('opt/QQ/../../outside'), tarfile.TarInfo('opt/QQ/escape')]:
            if member.name.endswith('escape'):
                member.type = tarfile.SYMTYPE
                member.linkname = '../../../outside'
            with self.subTest(name=member.name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                with self.assertRaises((ValueError, tarfile.TarError)):
                    qq.extract_qq_layer(self.archive(root, extra=member), root / 'staging')
                self.assertFalse((root / 'outside').exists())

    def test_fallback_builds_a_package_under_the_private_installer_umask(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = self.archive(root)
            def copy_download(url, target, **kwargs):
                target.write_bytes(archive.read_bytes())
                self.assertEqual(kwargs['digest'], qq.LAYER_SHA256)
            def build(arguments, **kwargs):
                self.assertEqual(arguments[:4], ['dpkg-deb', '--build', '--root-owner-group', '-Zgzip'])
                control = Path(arguments[-2]) / 'DEBIAN'
                self.assertEqual(control.stat().st_mode & 0o777, 0o755)
                self.assertIn('Version: 3.2.30-50969', (control / 'control').read_text())
                (root / 'qq-verified').mkdir()
            previous = os.umask(0o077)
            try:
                with patch.object(qq.urllib.request, 'urlopen', return_value=Response(b'{"token":"public-fixture"}')), patch.object(qq, 'download', side_effect=copy_download), patch.object(qq.subprocess, 'run', side_effect=build), patch.object(qq, 'validate_deb', return_value='3.2.30-50969'):
                    self.assertEqual(qq.fallback_package(root), '3.2.30-50969')
            finally:
                os.umask(previous)

    def test_deb_stream_extracts_when_gnu_tar_directory_restore_fails(self):
        with tempfile.TemporaryDirectory(prefix='qq proot test ') as tmp:
            root = Path(tmp)
            package = root / 'QQ.deb'
            # Real tar bytes are passed through a child process; only dpkg's
            # metadata/stream command is simulated, not Python extraction.
            package.write_bytes(gzip.decompress(self.archive(root).read_bytes()))
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            dpkg = bin_dir / 'dpkg-deb'
            dpkg.write_text('''#!/usr/bin/env python3
import sys
from pathlib import Path
if sys.argv[1] == '--info': pass
elif sys.argv[1] == '--field': print('arm64')
elif sys.argv[1] == '--fsys-tarfile': sys.stdout.buffer.write(Path(sys.argv[2]).read_bytes())
elif sys.argv[1] == '--extract':
    print('tar: ./opt/QQ: Cannot change mode: No such file or directory', file=sys.stderr)
    sys.exit(2)
else: sys.exit(99)
''')
            dpkg.chmod(0o755)
            with patch.dict(os.environ, {'PATH': str(bin_dir) + os.pathsep + os.environ['PATH']}):
                failed = subprocess.run(['dpkg-deb', '--extract', str(package), str(root / 'old')], capture_output=True)
                self.assertEqual(failed.returncode, 2)
                destination = root / 'staging'
                self.assertEqual(qq.validate_deb(package, destination), '3.2.30-50969')
                self.assertTrue((destination / 'opt/QQ/qq').stat().st_mode & 0o100)
                self.assertFalse((destination / 'etc').exists())

    def test_data_filter_does_not_restore_read_only_directory_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = tarfile.TarInfo('opt/QQ/resources/app/fonts')
            directory.type, directory.mode = tarfile.DIRTYPE, 0o555
            previous = os.umask(0o077)
            try:
                qq.extract_qq_layer(self.archive(root, extra=directory), root / 'staging')
                mode = (root / 'staging/opt/QQ/resources/app/fonts').stat().st_mode & 0o777
                self.assertEqual(mode, 0o700)
            finally:
                os.umask(previous)


if __name__ == '__main__':
    unittest.main()
