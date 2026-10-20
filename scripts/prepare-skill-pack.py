"""Copy an owner-supplied DSH archive as APK data; never run its installers.

The archive is deliberately excluded from the public source repository.
Usage: python3 scripts/prepare-skill-pack.py /path/to/pack.zip
"""
from pathlib import Path
import hashlib, json, os, re, sys, zipfile

root = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1])
target = root / 'phone-qq/private-skill-pack.zip'
with zipfile.ZipFile(source) as archive, zipfile.ZipFile(target.with_suffix('.new.zip'), 'w', compression=zipfile.ZIP_DEFLATED) as out:
    if archive.testzip() is not None: raise RuntimeError('Archive CRC failed')
    for info in archive.infolist():
        name = info.filename
        if info.is_dir(): continue
        if '..' in name.split('/') or name.startswith('/') or '\\' in name: raise RuntimeError('Unsafe archive path')
        if not (re.match(r'^dsh-lazy-pack-v5/materials/skills/[^/]+/', name)
                or re.match(r'^dsh-lazy-pack-v5/(?:prompts/[^/]+\.md|materials/shield-protocol\.md|materials/model-routes/[^/]+\.md)$', name)):
            continue
        data = archive.read(info)
        patterns = [x.encode() for x in os.environ.get('DSH_PRIVATE_PATTERNS', '').split('|') if x]
        if any(x.lower() in data.lower() for x in patterns): raise RuntimeError('Private owner information found')
        entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o100600 << 16
        out.writestr(entry, data)
target.with_suffix('.new.zip').replace(target)
print(json.dumps({'archiveBytes': target.stat().st_size, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}))
