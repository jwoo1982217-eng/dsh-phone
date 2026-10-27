import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('build_assets', Path(__file__).with_name('build-assets.py'))
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class PlatformPackagingTests(unittest.TestCase):
    def test_private_sdk_patch_manifest_and_guarded_variants_survive_both_copies(self):
        import hashlib
        with tempfile.TemporaryDirectory() as temporary:
            for label in ('tree', 'profile'):
                target = Path(temporary) / label / 'dsh-phone-qq'
                assets.copy_bundle('dsh-phone-qq', target, assets.ROOT / 'phone-qq')
                plan = json.loads((target / 'private-sdk-patches.json').read_text())
                self.assertEqual(plan['version'], 2)
                self.assertEqual(plan['sdkVersion'], '0.2.1-rc.2')
                self.assertGreaterEqual(len(plan['packages']), 182)
                self.assertEqual(len(plan['preservations']), 41)
                for helper in ('core-migration.js','core-transaction.js','private-sdk-v2.js','private-sdk-plan.js','compatibility-packages.js'):
                    self.assertTrue((target / helper).is_file(), helper)
                for row in plan['files']:
                    if row['source'].startswith('plugin:'):
                        data = (target / row['source'].removeprefix('plugin:')).read_bytes()
                        self.assertEqual(hashlib.sha256(data).hexdigest(), row['sha256'])

    def test_packaging_rejects_stale_plan_and_tampered_or_missing_v2_sources(self):
        import hashlib
        with tempfile.TemporaryDirectory() as temporary:
            tree = Path(temporary)
            core = tree/'node_modules/@deepseek-ai/dsh'; core.mkdir(parents=True)
            (core/'package.json').write_text(json.dumps({'version':'0.2.1-rc.2'}))
            plugin = tree/'node_modules/dsh-phone-qq'; plugin.mkdir()
            receipt = plugin/'private-sdk-patches.json'
            receipt.write_text(json.dumps({'version':1,'files':[]}))
            with self.assertRaisesRegex(RuntimeError,'not reviewed'):
                assets.validate_private_sdk_plan(tree)
            item = core/'index.js'; item.write_bytes(b'new core')
            row = {'relative':'@deepseek-ai/dsh/index.js','source':'tree:node_modules/@deepseek-ai/dsh/index.js','bytes':8,'sha256':hashlib.sha256(b'new core').hexdigest()}
            plan = {'version':2,'sdkVersion':'0.2.1-rc.2','baselines':[{'id':'old'}],'files':[row]}
            receipt.write_text(json.dumps(plan))
            self.assertEqual(assets.validate_private_sdk_plan(tree)['files'],1)
            item.write_bytes(b'tampered')
            with self.assertRaisesRegex(RuntimeError,'differs'):
                assets.validate_private_sdk_plan(tree)
            item.unlink()
            with self.assertRaisesRegex(RuntimeError,'missing'):
                assets.validate_private_sdk_plan(tree)
            row['source']='tree:../private/code'
            receipt.write_text(json.dumps(plan))
            with self.assertRaisesRegex(RuntimeError,'outside'):
                assets.validate_private_sdk_plan(tree)

    def test_preservation_receipts_must_bind_both_old_and_new_bytes(self):
        import hashlib
        with tempfile.TemporaryDirectory() as temporary:
            tree=Path(temporary); core=tree/'node_modules/@deepseek-ai/dsh'; core.mkdir(parents=True)
            (core/'package.json').write_text(json.dumps({'version':'0.2.1-rc.2'}))
            plugin=tree/'node_modules/dsh-phone-qq'; plugin.mkdir()
            item=core/'index.js'; item.write_bytes(b'new')
            row={'relative':'@deepseek-ai/dsh/index.js','source':'tree:node_modules/@deepseek-ai/dsh/index.js','bytes':3,'sha256':hashlib.sha256(b'new').hexdigest()}
            required={'relative':row['relative'],'sha256':hashlib.sha256(b'old').hexdigest()}
            plan={'version':2,'sdkVersion':'0.2.1-rc.2','baselines':[{'id':'old','requiredPreservations':[required]}],'files':[row]}
            receipt=plugin/'private-sdk-patches.json'; receipt.write_text(json.dumps(plan))
            with self.assertRaisesRegex(RuntimeError,'preservation'):
                assets.validate_private_sdk_plan(tree)
            plan['preservations']=[{'relative':row['relative'],'beforeSha256':required['sha256'],'afterSha256':row['sha256'],'disposition':'merged','verification':'fixture'}]
            receipt.write_text(json.dumps(plan)); self.assertEqual(assets.validate_private_sdk_plan(tree)['preservations'],1)
            plan['preservations'][0]['beforeSha256']='0'*64
            receipt.write_text(json.dumps(plan))
            with self.assertRaisesRegex(RuntimeError,'preservation'):
                assets.validate_private_sdk_plan(tree)

    def test_conversation_actions_survive_both_bundle_copies_and_missing_import_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            for label in ('tree', 'profile'):
                target = Path(temporary) / label / 'dsh-peer'
                assets.copy_bundle('dsh-peer', target, assets.ROOT / 'peer')
                self.assertTrue((target / 'conversation-actions/index.mjs').is_file())
                self.assertGreater(assets.validate_peer_files(target), 0)
                (target / 'conversation-actions/index.mjs').unlink()
                with self.assertRaisesRegex(RuntimeError, 'runtime reference'):
                    assets.validate_peer_files(target)

    def test_appearance_module_preserves_all_assets_and_upgrade_registration(self):
        import hashlib
        with tempfile.TemporaryDirectory() as temporary:
            source = assets.ROOT / 'appearance'
            target = Path(temporary) / 'dsh-appearance-center'
            assets.copy_bundle('dsh-appearance-center', target, source)
            self.assertGreaterEqual(assets.validate_peer_files(target), 5)
            for item in source.rglob('*'):
                if item.is_file() and (item.parent.name == 'themes' or item.name in ('client.js', 'page.js', 'page.css', 'visuals.js', 'runtime.css', 'catalog.json')):
                    self.assertEqual(hashlib.sha256(item.read_bytes()).digest(), hashlib.sha256((target / item.relative_to(source)).read_bytes()).digest())
            catalog = json.loads((target / 'assets/catalog.json').read_text())
            self.assertEqual(sum(len(p['themes']) for p in catalog['providers']), 224)
            missing = target / 'compat/opencode.mjs'
            missing.unlink()
            with self.assertRaisesRegex(RuntimeError, 'runtime reference'):
                assets.validate_peer_files(target)
            missing.write_bytes((source / 'compat/opencode.mjs').read_bytes())
            assets.validate_peer_files(target)
            self.assertIn('dsh-appearance-center', assets.BUNDLES)
            manifest = json.loads((assets.ROOT / 'home-template/profiles/phone/package.json').read_text())
            self.assertEqual(manifest['dsh']['profile']['bundles'].count('dsh-appearance-center'), 1)
            self.assertEqual(manifest['dependencies']['dsh-appearance-center'], 'file:./node_modules/dsh-appearance-center')
            runner = (assets.ROOT / 'app/src/main/java/com/dshphone/NodeRunner.kt').read_text()
            import re
            registration = re.search(r'listOf\(([^()]*)\)\.forEach \{ bundle ->', runner)
            self.assertIsNotNone(registration)
            registered = set(re.findall(r'"([^"]+)"', registration.group(1)))
            self.assertTrue({'dsh-team', 'dsh-appearance-center', 'dsh-knowledge-link', 'dsh-model-routing', 'dsh-knowledge-workbench'} <= registered)
            gradle = (assets.ROOT / 'app/build.gradle').read_text()
            expected_version = re.search(r'versionCode\s+(\d+)', gradle).group(1)
            self.assertEqual(assets.validate_asset_version(gradle, runner), expected_version)

    def test_phone_bundle_activates_packaged_subagent_scheduler(self):
        # 手机通过 phone-qq 应用 peer，必须在实际启用的 bundle 内登记调度器。
        manifest = json.loads((assets.ROOT / 'home-template/profiles/phone/package.json').read_text())
        self.assertIn('dsh-phone-qq', manifest['dsh']['profile']['bundles'])
        patch = (assets.ROOT / 'phone-qq/cordis.patch.yml').read_text()
        self.assertEqual(patch.count('id: dsh-subagent-scheduler'), 1)
        self.assertIn('name: dsh-peer/subagent-scheduler', patch)
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'dsh-peer'
            assets.copy_bundle('dsh-peer', target, assets.ROOT / 'peer')
            self.assertTrue((target / 'subagent-scheduler/index.mjs').is_file())
            self.assertIn('./subagent-scheduler', json.loads((target / 'package.json').read_text())['exports'])
            self.assertGreater(assets.validate_peer_files(target), 0)

    def test_framework_excludes_presets_and_retains_features(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tree, home = root / 'tree', root / 'home'
            for base in (tree / 'node_modules', home / 'profiles/phone/node_modules'):
                pack = base / 'dsh-phone-qq/bundled-packs/example.zip'
                pack.parent.mkdir(parents=True)
                pack.write_bytes(b'optional archive')
                model = base / 'dsh-peer/knowledge-link/kb/assets/model/model.onnx'
                model.parent.mkdir(parents=True)
                model.write_bytes(b'offline model')
            skill = home / 'skills/example/SKILL.md'
            skill.parent.mkdir(parents=True)
            skill.write_text('preset')
            assets.prepare_distribution(tree, home)
            self.assertFalse((home / 'skills').exists())
            for base in (tree / 'node_modules', home / 'profiles/phone/node_modules'):
                self.assertFalse((base / 'dsh-phone-qq/bundled-packs').exists())
                self.assertEqual((base / 'dsh-peer/knowledge-link/kb/assets/model/model.onnx').read_bytes(), b'offline model')
            self.assertFalse(json.loads((home / 'distribution.json').read_text())['presetSkills'])

    def test_dedup_only_removes_byte_identical_profile_files(self):
        import hashlib
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tree, home = root / 'tree', root / 'home'
            for base in (tree / 'node_modules/example', home / 'profiles/phone/node_modules/example'):
                base.mkdir(parents=True)
                (base / 'model.bin').write_bytes(b'identical model')
                (base / 'config.json').write_text('tree' if base.is_relative_to(tree) else 'profile')
            report = assets.deduplicate_profile_resources(tree, home)
            self.assertEqual(report, {'files': 1, 'bytes': len(b'identical model')})
            self.assertFalse((home / 'profiles/phone/node_modules/example/model.bin').exists())
            self.assertEqual((home / 'profiles/phone/node_modules/example/config.json').read_text(), 'profile')
            item = json.loads((home / '.shared-runtime-files.json').read_text())['files'][0]
            self.assertEqual(item['sha256'], hashlib.sha256(b'identical model').hexdigest())
            self.assertEqual((tree / item['source']).read_bytes(), b'identical model')
    def test_transitive_module_and_asset_closure_rejects_missing_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'index.mjs').write_text("import './feature/index.mjs';")
            (root / 'feature').mkdir()
            (root / 'feature/index.mjs').write_text("const asset = new URL('./page.html', import.meta.url);")
            with self.assertRaisesRegex(RuntimeError, 'runtime reference'):
                assets.validate_peer_files(root)
            (root / 'feature/page.html').write_text('<p>fixture</p>')
            self.assertEqual(assets.validate_peer_files(root), 3)
            (root / 'feature/index.mjs').write_text("import './missing.mjs';")
            with self.assertRaisesRegex(RuntimeError, 'runtime reference'):
                assets.validate_peer_files(root)
    def test_bundle_keeps_peer_runtime_imports_and_noema_guard_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'; source.mkdir()
            (source / 'package.json').write_text('{"name":"dsh-peer"}')
            for name in ('mcp-manager', 'memory-isolation', 'agent-cards', 'chat-files'):
                (source / name).mkdir()
                (source / name / 'index.mjs').write_text('export const ok = true;')
            assets.copy_bundle('dsh-peer', root / 'peer', source)
            for name in ('mcp-manager', 'memory-isolation', 'agent-cards', 'chat-files'):
                self.assertEqual((root / 'peer' / name / 'index.mjs').read_text(), 'export const ok = true;')
            (source / 'src').mkdir()
            (source / 'src/isolation.ts').write_text('export const guard = true;')
            assets.copy_bundle('@zseven-w/dsh-noema', root / 'noema', source)
            self.assertTrue((root / 'noema/src/isolation.ts').is_file())
    def test_resource_version_prevents_a_new_apk_from_reusing_an_old_extracted_runtime(self):
        self.assertEqual(assets.validate_asset_version('versionCode 44', 'const val ASSET_VERSION = "44"'), '44')
        with self.assertRaisesRegex(RuntimeError, 'stale runtime'):
            assets.validate_asset_version('versionCode 44', 'const val ASSET_VERSION = "43"')
        self.assertEqual(assets.validate_asset_version('versionCode 43', 'const val ASSET_VERSION = "43"'), '43')
    def test_mixed_sdk_generations_are_refused_before_packaging(self):
        with tempfile.TemporaryDirectory() as temporary:
            modules = Path(temporary) / 'node_modules'
            for name, version in [('dsh', '0.2.1-alpha.1'), ('dsh-llm', '0.1.0-rc.8')]:
                directory = modules / '@deepseek-ai' / name
                directory.mkdir(parents=True)
                (directory / 'package.json').write_text(json.dumps({'name': '@deepseek-ai/' + name, 'version': version}))
            with self.assertRaisesRegex(RuntimeError, 'SDK version mismatch'):
                assets.validate_sdk(modules)
            (modules / '@deepseek-ai/dsh-llm/package.json').write_text(json.dumps({'name': '@deepseek-ai/dsh-llm', 'version': '0.2.1-alpha.1'}))
            self.assertEqual(assets.validate_sdk(modules), '0.2.1-alpha.1')

    def test_npm_platform_rules(self):
        for manifest in ({}, {'os': ['android']}, {'os': ['!darwin']}, {'os': ['any'], 'cpu': ['arm64']}, {'cpu': 'arm64'}):
            self.assertTrue(assets.supports_platform(manifest), manifest)
        for manifest in ({'os': ['darwin']}, {'os': ['linux']}, {'os': ['!android']}, {'cpu': ['x64']}, {'os': ['any', '!android']}):
            self.assertFalse(assets.supports_platform(manifest), manifest)

    def test_staged_packages_are_filtered_without_touching_host_or_portable_js(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            host, staged = root / 'host/node_modules', root / 'android/node_modules'
            rows = {'@deepseek-ai/libreoffice-kit-darwin-arm64': {'os': ['darwin'], 'cpu': ['arm64']},
                    'sherpa-onnx-darwin-arm64': {'os': ['darwin']},
                    'portable': {}, 'android-native': {'os': ['android'], 'cpu': ['arm64']},
                    'portable/node_modules/foreign': {'os': ['win32']}}
            for name, metadata in rows.items():
                for base in (host, staged):
                    package = base / name; package.mkdir(parents=True, exist_ok=True)
                    (package / 'package.json').write_text(json.dumps({'name': name, **metadata}))
                    (package / 'index.js').write_text('export const keep = true;')
            # Manifests embedded as JS fixtures are not installed packages.
            fixture = staged / 'portable/fixtures/example'; fixture.mkdir(parents=True)
            (fixture / 'package.json').write_text('{"os":["darwin"]}')
            self.assertEqual(set(assets.remove_foreign_packages(staged)), set(rows) - {'portable', 'android-native'})
            for name in rows:
                self.assertTrue((host / name / 'package.json').is_file())
            for name in ('portable', 'android-native'):
                self.assertTrue((staged / name / 'index.js').is_file())
            self.assertTrue((fixture / 'package.json').is_file())


if __name__ == '__main__':
    unittest.main()
