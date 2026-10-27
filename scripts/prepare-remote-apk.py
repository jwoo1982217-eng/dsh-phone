"""Prepare the 122 connection maintenance release without mixing canonical rc.2 WIP."""
import argparse
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / 'scripts/remote-maintenance'
PROGRAMS = ('index.mjs', 'tunnel.mjs', 'relay.mjs', 'page.html', 'protocol.mjs', 'remote-service.mjs', 'transport-proxy.mjs')
OLD = {
    'index.mjs': '9ccb639041f65f08228366c1714529f444c56aaefc0a3b643ef4ebb870467d57',
    'tunnel.mjs': '93441c3e2347816ef5397e3227d58290611e8c6b3d36427ed72663d669a7da1b',
    'relay.mjs': '6127d0812f4fdc5989a32e2036f92a309918301b573de1e8c3a951e831304e21',
    'page.html': 'a32e942bc842aaf995c03f98d7fda57746fe8e674d0aa4b09a08f800b8d869c0',
    'protocol.mjs': '38882b147defb7d3e32301a2076d3fb97e2d08176e1d09d4487153b96533430e',
    'remote-service.mjs': None, 'transport-proxy.mjs': None,
}
ARCHIVES = ('app/src/main/assets/dsh-tree.tar', 'app/src/main/assets/dsh-home.tar')


def sha(data): return hashlib.sha256(data).hexdigest()


def file_sha(path):
    with Path(path).open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()


def project_file(project, relative, *, required=True):
    project = Path(project)
    if project.is_symlink(): raise ValueError('Prepared project is a link')
    project = project.resolve()
    if Path(relative).is_absolute() or any(part in ('', '.', '..') for part in relative.split('/')):
        raise ValueError('Prepared path outside project')
    target = project / relative; cursor = project
    for part in Path(relative).parts:
        cursor = cursor / part
        if cursor.is_symlink(): raise ValueError('Prepared path contains a link: ' + relative)
        if cursor != target and cursor.exists() and not cursor.is_dir(): raise ValueError('Prepared parent is not a directory')
    if target.exists() and not target.is_file(): raise ValueError('Prepared input is not a file: ' + relative)
    if required and not target.is_file(): raise ValueError('Prepared input missing: ' + relative)
    return target


def validate_cached_outputs(project, previous, manifest):
    if set(previous['archives']) != set(ARCHIVES): raise ValueError('Unexpected cached archive whitelist')
    for name, row in previous['archives'].items():
        path = project_file(project, name)
        if file_sha(path) != row['sha256'] or path.stat().st_size != row['bytes']:
            raise ValueError('Prepared runtime archive changed after validation')
    path = project_file(project, 'app/src/main/assets/remote-peer/manifest.json')
    try: saved = json.loads(path.read_text())
    except (ValueError, UnicodeError) as error: raise ValueError('Prepared migration manifest is malformed') from error
    if saved != manifest: raise ValueError('Prepared migration manifest differs from source')
    for row in manifest['files']:
        path = project_file(project, 'app/src/main/assets/remote-peer/files/' + row['name'])
        if path.stat().st_size != row['bytes'] or file_sha(path) != row['sha256']:
            raise ValueError('Prepared migration payload differs from source: ' + row['name'])


def patch_runtime_archive(path, programs, old_hashes, *, home):
    """Atomically rewrite owned program members; unknown bytes leave the input intact."""
    path = Path(path)
    if path.is_symlink() or not path.is_file(): raise ValueError('Runtime archive must be a regular file')
    if set(programs) != set(old_hashes) or any(not re.fullmatch(r'[a-z][a-z0-9-]*\.(mjs|html)', name) for name in programs):
        raise ValueError('Invalid program whitelist')
    prefix = ('profiles/phone/' if home else '') + 'node_modules/dsh-peer/'
    temporary = path.with_suffix('.remote-next.tar')
    physical, names, manifest = set(), set(), None
    kinds, ancestors = {}, set()
    def prospective_file(name):
        parents = ['/'.join(name.split('/')[:index]) for index in range(1, len(name.split('/')))]
        if name in names or name in ancestors or any(kinds.get(parent) is False for parent in parents):
            raise ValueError('Program target conflicts with an archive member: ' + name)
    created = False
    try:
        with tarfile.open(temporary, 'x') as target:
            created = True
            with tarfile.open(path, 'r|') as source:
                for member in source:
                    name = member.name.rstrip('/') if member.isdir() else member.name
                    if name.startswith('/') or any(part in ('', '.', '..') for part in name.split('/')) or name in names:
                        raise ValueError('Unsafe or duplicate archive member')
                    parents = ['/'.join(name.split('/')[:index]) for index in range(1, len(name.split('/')))]
                    if any(kinds.get(parent) is False for parent in parents) or not member.isdir() and name in ancestors:
                        raise ValueError('Archive member conflicts with a file ancestor')
                    names.add(name)
                    if not (member.isfile() or member.isdir()): raise ValueError('Unexpected archive link or device')
                    kinds[name] = member.isdir(); ancestors.update(parents)
                    content = source.extractfile(member) if member.isfile() else None
                    if home and name == '.shared-runtime-files.json':
                        manifest = (copy.copy(member), json.loads(content.read()))
                        continue
                    leaf = name[len(prefix):] if name.startswith(prefix) else None
                    if leaf in programs and not member.isfile(): raise ValueError('Owned program is not a regular file: ' + leaf)
                    if leaf in programs and member.isfile():
                        previous = content.read()
                        if sha(previous) not in {old_hashes[leaf], sha(programs[leaf])}:
                            raise ValueError('Unknown bundled program: ' + leaf)
                        member = copy.copy(member); member.size = len(programs[leaf])
                        content = io.BytesIO(programs[leaf]); physical.add(leaf)
                    target.addfile(member, content)
            if home:
                if manifest is None: raise ValueError('Verified shared-resource manifest missing')
                member, data = manifest
                if data.get('version') != 1 or not isinstance(data.get('files'), list): raise ValueError('Unsupported shared-resource manifest')
                rows, owned = [], set()
                for row in data['files']:
                    if not isinstance(row, dict): raise ValueError('Invalid shared-resource row')
                    leaf = row.get('source', '').removeprefix('node_modules/dsh-peer/')
                    expected_target = 'profiles/phone/node_modules/dsh-peer/' + leaf
                    if leaf in programs and row.get('source') == 'node_modules/dsh-peer/' + leaf:
                        if leaf in owned or leaf in physical or row.get('target') != expected_target or row.get('sha256') not in {old_hashes[leaf], sha(programs[leaf])}:
                            raise ValueError('Unknown or conflicting shared program: ' + leaf)
                        prospective_file(expected_target)
                        row = {**row, 'bytes': len(programs[leaf]), 'sha256': sha(programs[leaf])}; owned.add(leaf)
                    elif row.get('target') in {prefix + key for key in programs}:
                        raise ValueError('Shared target already owned by a different source')
                    rows.append(row)
                for leaf in programs:
                    if leaf in physical or leaf in owned: continue
                    if old_hashes[leaf] is not None: raise ValueError('Original shared program missing: ' + leaf)
                    prospective_file(prefix + leaf)
                    rows.append({'source': 'node_modules/dsh-peer/' + leaf, 'target': prefix + leaf,
                                 'bytes': len(programs[leaf]), 'sha256': sha(programs[leaf])})
                data['files'] = rows; payload = (json.dumps(data, separators=(',', ':')) + '\n').encode()
                member.size = len(payload); target.addfile(member, io.BytesIO(payload))
            else:
                for leaf, payload in programs.items():
                    if leaf in physical: continue
                    if old_hashes[leaf] is not None: raise ValueError('Original bundled program missing: ' + leaf)
                    name = prefix + leaf; parents = ['/'.join(name.split('/')[:index]) for index in range(1, len(name.split('/')))]
                    prospective_file(name)
                    names.add(name); kinds[name] = False; ancestors.update(parents)
                    member = tarfile.TarInfo(name); member.mode = 0o644; member.size = len(payload)
                    target.addfile(member, io.BytesIO(payload))
        os.replace(temporary, path)
    finally:
        if created: temporary.unlink(missing_ok=True)


def native_inputs(project):
    """Apply only reviewed stable121→122 deltas, never copy the canonical Activity WIP."""
    metadata = json.loads((RELEASE / 'native-inputs.json').read_text())
    existing, additions = metadata['existingFiles'], metadata['newFiles']
    allowed = set(existing)
    if not allowed or any(not name.startswith('app/') or '..' in Path(name).parts for name in [*existing, *additions]):
        raise ValueError('Invalid native source whitelist')
    patch = RELEASE / 'native.patch'
    if file_sha(patch) != metadata['patchSha256']: raise ValueError('Native patch changed without review')
    for line in patch.read_text().splitlines():
        if line.startswith(('--- ', '+++ ')):
            name = line[6:]
            if line[4:6] not in ('a/', 'b/') or name not in allowed: raise ValueError('Native patch path outside whitelist')
    states = []
    for name, hashes in existing.items():
        current = file_sha(project_file(project, name))
        if current not in (hashes['before'], hashes['after']): raise ValueError('Unknown native source: ' + name)
        states.append('after' if current == hashes['after'] else 'before')
    for name, expected in additions.items():
        if file_sha(project_file(ROOT, name)) != expected: raise ValueError('Unreviewed new native input: ' + name)
        destination = project_file(project, name, required=False)
        if destination.exists() and file_sha(destination) != expected: raise ValueError('Unknown prepared helper: ' + name)
    if all(state == 'before' for state in states):
        command = ['/usr/bin/patch', '-t', '-F', '0', '-p1', '-i', str(patch), '-d', str(project)]
        subprocess.run(command + ['-C'], check=True, capture_output=True)
        subprocess.run(command, check=True, capture_output=True)
    elif not all(state == 'after' for state in states): raise ValueError('Partial native delta requires inspection')
    for name, expected in additions.items():
        destination = project_file(project, name, required=False); destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists(): shutil.copy2(ROOT / name, destination)
    if any(file_sha(project_file(project, name)) != hashes['after'] for name, hashes in existing.items()):
        raise ValueError('Native result differs from reviewed release')
    return metadata


def prepare(base_apk, project, *, owner, task_source):
    project = Path(project).resolve(); base_apk = Path(base_apk).resolve()
    loader = importlib.util.spec_from_file_location('compaction_maintenance', ROOT / 'scripts/prepare-compaction-apk.py')
    maintenance = importlib.util.module_from_spec(loader); loader.loader.exec_module(maintenance)
    maintenance.validate_project_task(project, source=task_source, owner=owner)
    if file_sha(base_apk) != maintenance.BASE_SHA: raise ValueError('Unverified base APK')
    if not project.exists() or not any(project.iterdir()):
        maintenance.prepare(base_apk, project, task_source=task_source, owner=owner)
    source = json.loads(project_file(project, 'compaction-source.json').read_text())
    if source['baseApkSha256'] != maintenance.BASE_SHA or source['assetVersion'] != '121' or source['sdk'] != '0.2.1-alpha.1':
        raise ValueError('Not a verified 121 maintenance source')
    expected = json.loads((RELEASE / 'peer-inputs.json').read_text())
    for name, digest in expected['canonicalSourceSha256'].items():
        if file_sha(project_file(ROOT, name)) != digest: raise ValueError('Peer maintenance source changed without validation: ' + name)
    programs = {name: (RELEASE / 'peer-index.mjs' if name == 'index.mjs' else ROOT / 'peer' / name).read_bytes() for name in PROGRAMS}
    if sha(programs['index.mjs']) != expected['stableIndexSha256']: raise ValueError('Stable peer entry changed without validation')
    metadata = native_inputs(project)
    inputs = {name: sha(data) for name, data in programs.items()}
    manifest = {'version': 1, 'targetVersion': '122', 'sdk': '0.2.1-alpha.1', 'files': [
        {'name': name, 'oldSha256': OLD[name], 'sha256': sha(data), 'bytes': len(data)} for name, data in programs.items()]}
    fingerprint = sha(json.dumps({'programs': inputs, 'native': metadata}, sort_keys=True).encode())
    receipt = project_file(project, 'remote-source.json', required=False)
    if receipt.exists():
        previous = json.loads(receipt.read_text())
        if previous['inputFingerprint'] != fingerprint: raise ValueError('Prepared inputs changed; inspect generated release before rebuilding')
        validate_cached_outputs(project, previous, manifest)
        return previous
    assets = project / 'app/src/main/assets'
    manifest_file = project_file(project, 'app/src/main/assets/remote-peer/manifest.json', required=False)
    manifest_file.parent.mkdir(parents=True, exist_ok=True)
    for name, data in programs.items():
        destination = project_file(project, 'app/src/main/assets/remote-peer/files/' + name, required=False)
        destination.parent.mkdir(parents=True, exist_ok=True); destination.write_bytes(data)
    manifest_file.write_text(json.dumps(manifest, indent=2) + '\n')
    archives = {}
    for name, home in [('dsh-tree.tar', False), ('dsh-home.tar', True)]:
        archive = project_file(project, 'app/src/main/assets/' + name); patch_runtime_archive(archive, programs, OLD, home=home)
        archives[archive.relative_to(project).as_posix()] = {'sha256': file_sha(archive), 'bytes': archive.stat().st_size}
    result = {'versionCode': 122, 'versionName': '0.2.17', 'assetVersion': '122', 'sdk': '0.2.1-alpha.1',
              'baseApkSha256': maintenance.BASE_SHA, 'inputFingerprint': fingerprint, 'programs': manifest['files'], 'archives': archives}
    validate_cached_outputs(project, result, manifest)
    receipt.write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-apk', required=True); parser.add_argument('--project', required=True)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--task-source', choices=[str(ROOT), str(ROOT.parent / 'dsh-desktop-public')], default=str(ROOT))
    args = parser.parse_args()
    print(json.dumps(prepare(args.base_apk, args.project, owner=args.owner, task_source=args.task_source)))
