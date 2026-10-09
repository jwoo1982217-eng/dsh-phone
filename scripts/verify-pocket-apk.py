#!/usr/bin/env python3
"""Verify scanner dependencies are defined in the delivered APK, not just referenced."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import zipfile

REQUIRED = {
    'Lcom/journeyapps/barcodescanner/ScanOptions;',
    'Lcom/journeyapps/barcodescanner/CaptureActivity;',
    'Lcom/journeyapps/barcodescanner/CaptureManager;',
    'Lcom/google/zxing/MultiFormatReader;',
    'Landroidx/core/content/ContextCompat;',
    'Landroidx/core/app/ActivityCompat;',
}


def defined_classes(data):
    if not data.startswith(b'dex\n') or len(data) < 112:
        raise ValueError('Invalid DEX header')
    u32 = lambda offset: struct.unpack_from('<I', data, offset)[0]
    if u32(32) != len(data) or u32(40) != 0x12345678:
        raise ValueError('Invalid DEX size or byte order')
    strings_count, strings_offset = u32(56), u32(60)
    types_count, types_offset = u32(64), u32(68)
    classes_count, classes_offset = u32(96), u32(100)
    for count, offset, width in [(strings_count, strings_offset, 4),
                                 (types_count, types_offset, 4),
                                 (classes_count, classes_offset, 32)]:
        if offset + count * width > len(data):
            raise ValueError('Invalid DEX table bounds')
    names = set()
    for i in range(classes_count):
        type_index = u32(classes_offset + 32 * i)
        if type_index >= types_count:
            raise ValueError('Invalid DEX class type')
        string_index = u32(types_offset + 4 * type_index)
        if string_index >= strings_count:
            raise ValueError('Invalid DEX descriptor index')
        cursor = u32(strings_offset + 4 * string_index)
        for _ in range(5):
            if cursor >= len(data):
                raise ValueError('Invalid DEX string offset')
            value = data[cursor]
            cursor += 1
            if value < 128:
                break
        else:
            raise ValueError('Invalid DEX string length')
        end = data.index(b'\0', cursor)
        names.add(data[cursor:end].decode('utf-8'))
    return names


def verify(apk):
    names = set()
    with zipfile.ZipFile(apk) as archive:
        for entry in archive.namelist():
            if re.fullmatch(r'classes(?:\d+)?\.dex', entry):
                names.update(defined_classes(archive.read(entry)))
    missing = sorted(REQUIRED - names)
    if missing:
        raise ValueError('Pocket scanner runtime classes missing from APK: ' + ', '.join(missing))
    return {'apk': str(apk), 'sha256': hashlib.sha256(Path(apk).read_bytes()).hexdigest(),
            'requiredClassesDefined': sorted(REQUIRED), 'definedClasses': len(names)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk', type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.apk), ensure_ascii=False))
    except (ValueError, OSError, zipfile.BadZipFile, struct.error) as error:
        parser.exit(1, str(error) + '\n')
