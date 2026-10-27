"""Offline guard checks. No ADB calls or production packages are involved."""
import importlib.util, io, subprocess, tarfile, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('android_core',Path(__file__).with_name('test-android-core-upgrade.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Safety(unittest.TestCase):
    def test_production_and_malformed_names_refused(self):
        for name in ['com.dshphone','com.dshphone.mcpupgradeverification','com.dshphone.mcpupgradeverification.t'+'a'*31,'com.dshphone.mcpupgradeverification.t'+'g'*32]:
            with self.assertRaises(ValueError):m.CoreFixtureDevice('adb','fixture',name,[])
    def test_uid_requires_exact_isolated_package(self):
        name=m.guard.new_fixture_package();self.assertEqual(m.guard.parse_fixture_uid('package:'+name+' uid:12345\n',name),12345)
        for output in ['package:'+name+' uid:999','package:com.dshphone uid:12345','package:'+name+' uid:12345\npackage:com.dshphone uid:12346']:
            with self.assertRaises(ValueError):m.guard.parse_fixture_uid(output,name)
    def test_archive_rejects_links_and_directories(self):
        with tempfile.TemporaryDirectory()as tmp,tarfile.open(fileobj=io.BytesIO(),mode='w')as archive:
            root=Path(tmp);(root/'regular').write_text('public fixture');(root/'link').symlink_to(root/'regular')
            for f in [root,root/'link']:
                with self.assertRaises(ValueError):m.archive_file(archive,f,'invalid')
            m.archive_file(archive,root/'regular','tree/regular')
    def test_nested_regular_files_include_explicit_parent_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp)/'public.js'; source.write_text('offline public fixture')
            output = io.BytesIO()
            with tarfile.open(fileobj=output,mode='w') as archive:
                name = 'tree/tools/pnpm/' + '/'.join(['nested-directory']*8) + '/public.js'
                m.archive_file(archive,source,name)
                m.archive_file(archive,source,'tree/second.js')
            output.seek(0)
            with tarfile.open(fileobj=output,mode='r') as archive:
                members=archive.getmembers(); seen=set()
                for entry in members:
                    self.assertFalse(entry.issym() or entry.islnk())
                    for parent in Path(entry.name).parents:
                        if parent.as_posix()!='.':self.assertIn(parent.as_posix(),seen)
                    seen.add(entry.name.rstrip('/'))
                self.assertEqual(len(seen),len(members))
    def test_installer_refuses_apk_identity_before_adb(self):
        device=m.CoreFixtureDevice('adb','fixture',m.guard.new_fixture_package(),[])
        with patch.object(m.guard,'apk_identity',return_value={'package':'com.dshphone','versionCode':1}),patch.object(m.subprocess,'run')as run:
            with self.assertRaises(ValueError):device.install(Path('/fixture.apk'),Path('/aapt'),1)
            run.assert_not_called()
    def test_instrumentation_has_only_fixed_validated_target(self):
        name=m.guard.new_fixture_package();trace=[];device=m.CoreFixtureDevice('adb','fixture',name,trace)
        with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'fixture',''))as run:device.instrument()
        self.assertEqual(run.call_args.args[0],['adb','-s','fixture','shell','am','instrument','-w','-r',name+'/com.dshphone.CoreUpgradeInstrumentation'])
        self.assertEqual(trace[0]['operation'],'instrument-core')
if __name__=='__main__':unittest.main()
