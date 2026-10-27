"""Exercise release-resource rewriting without copying a full Android project."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('remote_release', Path(__file__).with_name('prepare-remote-apk.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

def sha(data): return hashlib.sha256(data).hexdigest()


class RemoteMaintenanceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='remote-resource-', dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.tmp.cleanup)
        self.archive = Path(self.tmp.name) / 'runtime.tar'
        self.old = b'known original program'
        self.new = b'new connection program'
        self.added = b'new helper'
        self.programs = {'index.mjs': self.new, 'remote-service.mjs': self.added}
        self.old_hashes = {'index.mjs': sha(self.old), 'remote-service.mjs': None}

    def write_tar(self, entries):
        with tarfile.open(self.archive, 'w') as tar:
            for name, data in entries.items():
                row = tarfile.TarInfo(name); row.size = len(data); row.mode = 0o644
                tar.addfile(row, io.BytesIO(data))

    def read_tar(self):
        with tarfile.open(self.archive) as tar:
            return {row.name: tar.extractfile(row).read() for row in tar if row.isfile()}

    def test_tree_replaces_only_owned_programs_and_materializes_new_helper(self):
        self.write_tar({'node_modules/dsh-peer/index.mjs': self.old, 'node_modules/keep/data': b'keep'})
        release.patch_runtime_archive(self.archive, self.programs, self.old_hashes, home=False)
        data = self.read_tar()
        self.assertEqual(self.new, data['node_modules/dsh-peer/index.mjs'])
        self.assertEqual(self.added, data['node_modules/dsh-peer/remote-service.mjs'])
        self.assertEqual(b'keep', data['node_modules/keep/data'])

    def test_shared_home_manifest_tracks_new_bytes_and_preserves_other_rows(self):
        keep = {'source': 'node_modules/keep/data', 'target': 'profiles/phone/node_modules/keep/data', 'bytes': 4, 'sha256': sha(b'keep')}
        old_row = {'source': 'node_modules/dsh-peer/index.mjs', 'target': 'profiles/phone/node_modules/dsh-peer/index.mjs', 'bytes': len(self.old), 'sha256': sha(self.old)}
        self.write_tar({'.shared-runtime-files.json': json.dumps({'version': 1, 'files': [old_row, keep]}).encode(), 'profile-note': b'preserve'})
        release.patch_runtime_archive(self.archive, self.programs, self.old_hashes, home=True)
        data = self.read_tar(); rows = json.loads(data['.shared-runtime-files.json'])['files']
        by_source = {row['source']: row for row in rows}
        self.assertEqual(sha(self.new), by_source[old_row['source']]['sha256'])
        self.assertEqual(sha(self.added), by_source['node_modules/dsh-peer/remote-service.mjs']['sha256'])
        self.assertEqual(keep, by_source[keep['source']]); self.assertEqual(b'preserve', data['profile-note'])

    def test_unknown_program_or_manifest_hash_never_replaces_original_archive(self):
        for home in [False, True]:
            entries = {('profiles/phone/' if home else '') + 'node_modules/dsh-peer/index.mjs': b'user patch'}
            if home:
                entries['.shared-runtime-files.json'] = json.dumps({'version': 1, 'files': []}).encode()
            self.write_tar(entries); before = self.archive.read_bytes()
            with self.assertRaises(ValueError): release.patch_runtime_archive(self.archive, self.programs, self.old_hashes, home=home)
            self.assertEqual(before, self.archive.read_bytes())
            self.assertFalse(self.archive.with_suffix('.remote-next.tar').exists())

    def test_missing_original_tree_program_is_rejected(self):
        self.write_tar({'node_modules/keep/data': b'keep'}); before = self.archive.read_bytes()
        with self.assertRaises(ValueError): release.patch_runtime_archive(self.archive, self.programs, self.old_hashes, home=False)
        self.assertEqual(before, self.archive.read_bytes())

    def test_repeat_rewrite_is_idempotent(self):
        self.write_tar({'node_modules/dsh-peer/index.mjs': self.old})
        release.patch_runtime_archive(self.archive, self.programs, self.old_hashes, home=False)
        before = self.read_tar()
        release.patch_runtime_archive(self.archive, self.programs, self.old_hashes, home=False)
        self.assertEqual(before, self.read_tar())

    def test_archive_paths_and_duplicate_members_are_rejected(self):
        self.write_tar({'../escape': b'keep', 'node_modules/dsh-peer/index.mjs': self.old})
        before = self.archive.read_bytes()
        with self.assertRaises(ValueError): release.patch_runtime_archive(self.archive, self.programs, self.old_hashes, home=False)
        self.assertEqual(before, self.archive.read_bytes())

    def test_directory_at_new_program_path_and_file_ancestor_are_rejected(self):
        for collision, directory in [('node_modules/dsh-peer/remote-service.mjs', True), ('node_modules/dsh-peer', False)]:
            with tarfile.open(self.archive, 'w') as tar:
                row = tarfile.TarInfo('node_modules/dsh-peer/index.mjs'); row.size = len(self.old)
                tar.addfile(row, io.BytesIO(self.old))
                row = tarfile.TarInfo(collision)
                if directory: row.type = tarfile.DIRTYPE
                tar.addfile(row)
            before = self.archive.read_bytes()
            with self.assertRaises(ValueError): release.patch_runtime_archive(self.archive, self.programs, self.old_hashes, home=False)
            self.assertEqual(before, self.archive.read_bytes())

    def test_cached_preparation_requires_exact_migration_manifest_and_payloads(self):
        project = Path(self.tmp.name) / 'project'; remote = project / 'app/src/main/assets/remote-peer'
        (remote / 'files').mkdir(parents=True)
        manifest = {'version': 1, 'targetVersion': '122', 'sdk': '0.2.1-alpha.1', 'files': [
            {'name': name, 'oldSha256': self.old_hashes[name], 'sha256': sha(data), 'bytes': len(data)} for name, data in self.programs.items()]}
        archives = {}
        for name in ['dsh-tree.tar', 'dsh-home.tar']:
            rel = 'app/src/main/assets/' + name; p = project / rel; p.write_bytes(b'archive')
            archives[rel] = {'sha256': sha(b'archive'), 'bytes': 7}
        for name, data in self.programs.items(): (remote / 'files' / name).write_bytes(data)
        (remote / 'manifest.json').write_text(json.dumps(manifest))
        release.validate_cached_outputs(project, {'archives': archives}, manifest)
        (remote / 'manifest.json').write_text('{}')
        with self.assertRaises(ValueError): release.validate_cached_outputs(project, {'archives': archives}, manifest)
        (remote / 'manifest.json').write_text(json.dumps(manifest)); (remote / 'files/index.mjs').unlink()
        with self.assertRaises(ValueError): release.validate_cached_outputs(project, {'archives': archives}, manifest)

    def test_shared_program_target_cannot_be_an_implicit_directory(self):
        original = {'source': 'node_modules/dsh-peer/index.mjs', 'target': 'profiles/phone/node_modules/dsh-peer/index.mjs', 'bytes': len(self.old), 'sha256': sha(self.old)}
        helper = {'source': 'node_modules/dsh-peer/remote-service.mjs', 'target': 'profiles/phone/node_modules/dsh-peer/remote-service.mjs', 'bytes': len(self.added), 'sha256': sha(self.added)}
        for already_shared in [False, True]:
            rows = [original, helper] if already_shared else [original]
            self.write_tar({'.shared-runtime-files.json': json.dumps({'version': 1, 'files': rows}).encode(), 'profiles/phone/node_modules/dsh-peer/remote-service.mjs/user-data': b'keep'})
            before = self.archive.read_bytes()
            with self.assertRaises(ValueError): release.patch_runtime_archive(self.archive, self.programs, self.old_hashes, home=True)
            self.assertEqual(before, self.archive.read_bytes())

    def test_native_helper_and_parent_aliases_never_write_outside_project(self):
        root = Path(self.tmp.name) / 'source'; directory = root / 'scripts/remote-maintenance'; directory.mkdir(parents=True)
        helper = 'app/src/main/java/com/dshphone/PeerConnection.kt'; source = root / helper
        source.parent.mkdir(parents=True); source.write_bytes(b'canonical helper')
        patch_data = '--- a/app/build.gradle\n+++ b/app/build.gradle\n@@ -1 +1 @@\n-before\n+after\n'
        (directory / 'native.patch').write_text(patch_data)
        (directory / 'native-inputs.json').write_text(json.dumps({'existingFiles': {'app/build.gradle': {'before': sha(b'before\n'), 'after': sha(b'after\n')}}, 'newFiles': {helper: sha(b'canonical helper')}, 'patchSha256': sha(patch_data.encode())}))
        outside = Path(self.tmp.name) / 'outside'; outside.mkdir()
        for parent_alias in [False, True]:
            project = Path(self.tmp.name) / ('parent-project' if parent_alias else 'helper-project')
            (project / 'app').mkdir(parents=True); (project / 'app/build.gradle').write_bytes(b'after\n')
            if parent_alias: (project / 'app/src').symlink_to(outside, target_is_directory=True)
            else:
                destination = project / helper; destination.parent.mkdir(parents=True); destination.symlink_to(outside / 'PeerConnection.kt')
            with patch.object(release, 'ROOT', root), patch.object(release, 'RELEASE', directory):
                with self.assertRaises(ValueError): release.native_inputs(project)
            self.assertEqual([], list(outside.rglob('*')))


if __name__ == '__main__': unittest.main()
