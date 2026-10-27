"""Registered maintenance builds may span explicitly selected canonical sources."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).with_name('prepare-compaction-apk.py'))
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


class MaintenanceTaskTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='maintenance-owner-', dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.temporary.cleanup)
        self.task = Path(self.temporary.name)
        self.source = maintenance.ROOT
        self.owner = 'same-authorized-chat'
        self.record = {'source': str(self.source), 'owner': self.owner, 'status': 'open'}
        self.project = self.task / 'generated/project'
        self.write_record()

    def write_record(self):
        (self.task / '.task-artifacts.json').write_text(json.dumps(self.record))

    def test_default_source_stays_strict_and_closed_tasks_are_rejected(self):
        maintenance.validate_project_task(self.project)
        self.record['source'] = str(self.source.parent / 'dsh-desktop-public')
        self.write_record()
        with self.assertRaises(ValueError): maintenance.validate_project_task(self.project)
        self.record.update(source=str(self.source), status='closed')
        self.write_record()
        with self.assertRaises(ValueError): maintenance.validate_project_task(self.project)

    def test_explicit_sibling_source_requires_the_same_owner(self):
        sibling = self.source.parent / 'dsh-desktop-public'
        self.record['source'] = str(sibling)
        self.write_record()
        record = maintenance.validate_project_task(self.project, source=sibling, owner=self.owner)
        self.assertEqual(self.owner, record['owner'])
        with self.assertRaises(ValueError):
            maintenance.validate_project_task(self.project, source=sibling, owner='another-chat')

    def test_retained_and_escaped_paths_are_never_build_destinations(self):
        with self.assertRaises(ValueError): maintenance.validate_project_task(self.task / 'retained')
        outside = self.task / 'outside'
        outside.mkdir()
        (self.task / 'generated').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError): maintenance.validate_project_task(self.project)


if __name__ == '__main__': unittest.main()
