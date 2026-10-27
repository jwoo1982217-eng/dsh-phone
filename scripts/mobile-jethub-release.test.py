import importlib.util
from pathlib import Path
import hashlib
import json
import tempfile
import unittest
spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('mobile-jethub-release.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class SharedResourcesTest(unittest.TestCase):
    def test_equal_length_change_refuses_all_writes_then_corrected_input_recovers(self):
        with tempfile.TemporaryDirectory(prefix='JetHub 中文 空格 ') as d:
            root=Path(d);tree=root/'tree';home=root/'home';tree.mkdir();home.mkdir()
            rows=[]
            for name, data in [('first',b'correct'),('last',b'allowed')]:
                p=tree/'node_modules'/name;p.parent.mkdir(exist_ok=True);p.write_bytes(data)
                rows.append({'source':'node_modules/'+name,'target':'profiles/phone/node_modules/'+name,
                             'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
            manifest=home/'.shared-runtime-files.json';manifest.write_text(json.dumps({'version':1,'files':rows}))
            (tree/'node_modules/last').write_bytes(b'CORRUPT')
            with self.assertRaises(ValueError):m.hydrate(tree,home)
            self.assertFalse((home/'profiles').exists());self.assertTrue(manifest.exists())
            (tree/'node_modules/last').write_bytes(b'allowed')
            self.assertEqual(m.hydrate(tree,home),2)
            rebuilt=m.deduplicate(tree,home);self.assertEqual(len(rebuilt),2)
            self.assertEqual(m.hydrate(tree,home),2)
            self.assertEqual((home/'profiles/phone/node_modules/last').read_bytes(),b'allowed')
    def test_unknown_apk_rejected_before_output_or_stage_creation(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);p=root/'unknown.apk';p.write_bytes(b'unknown')
            with self.assertRaises(ValueError):m.build(p,root/'hub',root/'stage',root/'out')
            self.assertFalse((root/'stage').exists());self.assertFalse((root/'out').exists())
    def test_path_traversal_rejected(self):
        with self.assertRaises(ValueError):m.safe_child(Path('/tmp/safe'),'../outside')
        with self.assertRaises(ValueError):m.safe_child(Path('/tmp/safe'),'/outside')

if __name__=='__main__':unittest.main()
