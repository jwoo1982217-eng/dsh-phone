import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('build_assets', Path(__file__).with_name('build-assets.py'))
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class PlatformPackagingTests(unittest.TestCase):
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
            for name in ('mcp-manager', 'memory-isolation', 'agent-cards'):
                (source / name).mkdir()
                (source / name / 'index.mjs').write_text('export const ok = true;')
            assets.copy_bundle('dsh-peer', root / 'peer', source)
            for name in ('mcp-manager', 'memory-isolation', 'agent-cards'):
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
