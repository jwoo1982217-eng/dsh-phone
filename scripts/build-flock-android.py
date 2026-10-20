"""Build the official Node-API flock binding for Android/Bionic (no lock bypass)."""
from pathlib import Path
import os
import platform
import subprocess

ROOT = Path(__file__).resolve().parents[1]
NDK = Path(os.environ['ANDROID_NDK_HOME'])
HOST = {'Darwin': 'darwin-x86_64', 'Linux': 'linux-x86_64'}[platform.system()]
BIN = NDK / 'toolchains/llvm/prebuilt' / HOST / 'bin'
if os.environ.get('NODE_API_HEADERS'):
    headers = Path(os.environ['NODE_API_HEADERS'])
else:
    headers = next((path for path in (Path('/usr/local/include/node'), Path('/opt/homebrew/include/node'), Path('/usr/include/node'))
                    if (path / 'node_api.h').is_file()), None)
if headers is None or not (headers / 'node_api.h').is_file():
    raise SystemExit('Install Node development headers or set NODE_API_HEADERS.')
target = ROOT / 'app/src/main/jniLibs/arm64-v8a/libdshflock.so'
target.parent.mkdir(parents=True, exist_ok=True)
subprocess.run([str(BIN / 'aarch64-linux-android28-clang'), '-shared', '-fPIC', '-O2', '-DNAPI_VERSION=8',
                '-fvisibility=hidden', '-I' + str(headers), str(ROOT / 'native/flock.c'),
                '-Wl,-z,max-page-size=16384', '-o', str(target)], check=True)
subprocess.run([str(BIN / 'llvm-strip'), '--strip-unneeded', str(target)], check=True)
print('Built Android kernel flock binding:', target.stat().st_size, 'bytes')
