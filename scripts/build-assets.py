"""Build a blank phone runtime from this repository, never from a user's DSH_HOME."""
from pathlib import Path
import json
import os
import re
import shutil
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / 'runtime'
MODULES = DEPLOY / 'node_modules'
ASSETS = ROOT / 'app/src/main/assets'
BUNDLES = ('dsh-codearts-auth', 'dsh-phone-account', 'dsh-phone-qq', 'dsh-phone-control', 'dsh-phone-cloud-tools', 'dsh-peer', '@zseven-w/dsh-noema')


def copy_bundle(name, destination, source=None):
    source = source or MODULES / name
    manifest = json.loads((source / 'package.json').read_text())
    destination.mkdir(parents=True)
    (destination / 'package.json').write_text(json.dumps(manifest, indent=2) + '\n')
    entries = ('LICENSE', 'LICENSE.openclaw', 'bin', 'sample-tools', 'lib', 'locale', 'vendor', 'agent-cards', 'chat-history', 'memory-isolation', 'mcp-manager', 'controlled-market', 'workflow-hub', 'cards-client.js', 'index.js', 'config.js', 'manager.js', 'bridge.mjs', 'cli.mjs', 'skills',
                  'index.mjs', 'protocol.mjs', 'relay.mjs', 'tunnel.mjs', 'proxy.mjs', 'ui-reuse.mjs', 'browser-session.mjs', 'config-sync.mjs', 'skill-import.js',
                  'account.js', 'messages-adapter.js', 'core-migration.js', 'plugin-compat.js', 'chatgpt.js', 'chatgpt-account.js', 'chatgpt-protocol.js',
                  'chatgpt-adapter.js', 'chatgpt-page.html', 'persona.js', 'skills.js', 'phone-home.js', 'setup.js', 'qq-login.js', 'qq-download.py', 'code-access.js', 'workspace.js', 'skills.html', 'workspace.html', 'packs.js', 'replace-skills.js', 'bundled-packs', 'packs.html', 'skill-import.js', 'browser-compat.js', 'zip.js', 'runtime.js', 'runtime-catalog.json', 'runtime-preflight.js', 'web-fetch.js', 'runtime-upstream-MIT.txt', 'presentation.css', 'presentation.js', 'platforms.json', 'page.html', 'cordis.patch.yml')
    if name == '@zseven-w/dsh-noema':
        entries += ('src',)
    for entry in entries:
        item = source / entry
        if item.is_dir():
            shutil.copytree(item, destination / entry)
        elif item.is_file():
            shutil.copy2(item, destination / entry)


def scrub_owner(member):
    member.uname=member.gname='';member.uid=member.gid=0;member.pax_headers={}
    return member

def make_tar(source, target):
    temporary = target.with_suffix('.new.tar')
    try:
        with tarfile.open(temporary, 'w') as archive:
            for item in sorted(source.rglob('*')):
                relative = item.relative_to(source)
                if any(part in ('.bin', '.DS_Store', '.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json') or part.startswith('._') for part in relative.parts):
                    continue
                if item.is_symlink():
                    raise RuntimeError(f'Unexpected deployment symlink: {relative}')
                archive.add(item, arcname=str(relative), recursive=False, filter=scrub_owner)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def supports_platform(manifest, system='android', cpu='arm64'):
    """npm os/cpu allow/deny lists; unspecified and wildcard packages are portable."""
    def allowed(values, value):
        if not values:
            return True
        if isinstance(values, str):
            values = [values]
        if '!' + value in values or '!any' in values:
            return False
        positives = [item for item in values if not item.startswith('!')]
        return not positives or value in positives or 'any' in positives
    return allowed(manifest.get('os'), system) and allowed(manifest.get('cpu'), cpu)


def remove_foreign_packages(modules):
    removed = []
    # Work only on the staged Android copy, including nested package installs.
    for manifest_path in sorted(modules.rglob('package.json'), key=lambda item: len(item.parts)):
        if not manifest_path.exists():
            continue
        package = manifest_path.parent
        if package.parent.name != 'node_modules' and not (package.parent.name.startswith('@') and package.parent.parent.name == 'node_modules'):
            continue
        manifest = json.loads(manifest_path.read_text())
        if not supports_platform(manifest):
            removed.append(str(package.relative_to(modules)))
            shutil.rmtree(package)
    return removed


def validate_sdk(modules):
    """A packaged phone must not mix released DSH SDK generations."""
    scope = modules / '@deepseek-ai'
    core = json.loads((scope / 'dsh/package.json').read_text())
    if core.get('name') != '@deepseek-ai/dsh' or not core.get('version'):
        raise RuntimeError('Phone core manifest invalid')
    for directory in scope.iterdir():
        if directory.name != 'dsh' and not directory.name.startswith('dsh-'):
            continue
        manifest = json.loads((directory / 'package.json').read_text())
        if manifest.get('name') != '@deepseek-ai/' + directory.name or manifest.get('version') != core['version']:
            raise RuntimeError('Phone SDK version mismatch: ' + directory.name)
    return core['version']


def validate_asset_version(gradle_source, runner_source):
    import re
    app = re.search(r'\bversionCode\s+(\d+)', gradle_source)
    assets = re.search(r'const val ASSET_VERSION\s*=\s*"(\d+)"', runner_source)
    if not app or not assets or app.group(1) != assets.group(1):
        raise RuntimeError('Application versionCode and NodeRunner ASSET_VERSION must match before packaging; otherwise an APK update may retain stale runtime assets.')
    return app.group(1)


def validate_peer_files(directory):
    """Check literal relative module and asset references before publishing tars."""
    root = directory.resolve()
    pending = [root / 'index.mjs']
    seen = set()
    pattern = re.compile(r"(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|new URL\(\s*)['\"](\.[^'\"]+)['\"](?!\s*\+)")
    while pending:
        file = pending.pop()
        if file in seen:
            continue
        seen.add(file)
        if not file.is_file():
            raise RuntimeError('Missing peer runtime file: ' + str(file.relative_to(root)))
        if file.suffix not in ('.mjs', '.js'):
            continue
        for relative in pattern.findall(file.read_text()):
            target = (file.parent / relative).resolve()
            if not target.is_relative_to(root) or not target.is_file():
                raise RuntimeError('Missing or escaped peer runtime reference: ' + relative + ' in ' + str(file.relative_to(root)))
            pending.append(target)
    return len(seen)


def main():
    validate_asset_version((ROOT/'app/build.gradle').read_text(), (ROOT/'app/src/main/java/com/dshphone/NodeRunner.kt').read_text())
    import subprocess
    subprocess.run(['node', str(ROOT/'scripts/build-agent-cards-client.mjs')], check=True)
    for extension in ('css', 'js'):
        shutil.copy2(ROOT/f'app/src/main/assets/dsh-phone.{extension}', ROOT/f'phone-qq/presentation.{extension}')
    shutil.copy2(ROOT/'app/src/main/assets/dsh-phone.compat.js', ROOT/'phone-qq/browser-compat.js')
    for source, target in [('dsh-phone.css', 'presentation.css'), ('dsh-phone.js', 'presentation.js'),
                           ('dsh-phone.compat.js', 'browser-compat.js')]:
        shutil.copy2(ASSETS/source, ROOT/'peer'/target)
    shutil.copy2(ROOT/'phone-qq/skill-import.js', ROOT/'peer/skill-import.js')
    if not (MODULES / '@deepseek-ai/dsh/package.json').is_file():
        raise SystemExit('Run pnpm install --frozen-lockfile --ignore-scripts in runtime/ first.')
    print('Validated phone SDK: ' + validate_sdk(MODULES))
    # Local file dependencies may still contain an earlier copied adapter.
    for name in ('index.js', 'package.json'):
        source, target = DEPLOY / 'stubs/sharp' / name, MODULES / 'sharp' / name
        if not target.exists() or not source.samefile(target):
            shutil.copy2(source, target)
    # Restore the pinned Android boot/HMR and Windows ABI compatibility sources.
    for overlay in (DEPLOY / 'overlays').rglob('*'):
        if overlay.is_file():
            shutil.copy2(overlay, MODULES / overlay.relative_to(DEPLOY / 'overlays'))
    for name, source in [('dsh-codearts-auth', ROOT / 'vendor/dsh-codearts-auth'),
                         ('dsh-channel-qq', ROOT / 'vendor/dsh-channel-qq'),
                         ('dsh-phone-account', ROOT / 'phone-account'),
                         ('dsh-phone-qq', ROOT / 'phone-qq'),
                         ('dsh-phone-control', ROOT / 'phone-control'),
                         ('dsh-phone-cloud-tools', ROOT / 'phone-cloud-tools'),
                         ('dsh-peer', ROOT / 'peer'),
                         ('@zseven-w/dsh-noema', ROOT / 'vendor/dsh-noema')]:
        target = MODULES / name
        shutil.rmtree(target, ignore_errors=True)
        copy_bundle(name, target, source)
    # ESM tests and local editing resolve the same hoisted dependency tree.
    if not (ROOT / 'node_modules').exists():
        (ROOT / 'node_modules').symlink_to('runtime/node_modules', target_is_directory=True)
    ASSETS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='dsh-phone-assets-') as temporary:
        work = Path(temporary)
        tree, home = work / 'tree', work / 'home'
        tree.mkdir()
        shutil.copytree(MODULES, tree / 'node_modules',
                        ignore=shutil.ignore_patterns('.bin', '.DS_Store', '._*'))
        removed = remove_foreign_packages(tree / 'node_modules')
        print('Excluded foreign platform packages: ' + ', '.join(removed))
        shutil.copy2(DEPLOY / 'package.json', tree / 'package.json')
        shutil.copytree(DEPLOY / 'tools', tree / 'tools')
        shutil.copytree(ROOT / 'home-template', home)
        for name in BUNDLES:
            copy_bundle(name, home / 'profiles/phone/node_modules' / name)
        for base in (tree / 'node_modules', home / 'profiles/phone/node_modules'):
            validate_peer_files(base / 'dsh-peer')
        make_tar(tree, ASSETS / 'dsh-tree.tar')
        make_tar(home, ASSETS / 'dsh-home.tar')
    print('Built blank phone assets. Personal credentials and bot configurations were not read.')


if __name__ == '__main__':
    main()
