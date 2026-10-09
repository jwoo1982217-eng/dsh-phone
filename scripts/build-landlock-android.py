"""Build the shipped fail-closed Landlock launcher for Android/Bionic."""
from pathlib import Path
import os
import platform
import subprocess

ROOT = Path(__file__).resolve().parents[1]
NDK = Path(os.environ['ANDROID_NDK_HOME'])
HOST = {'Darwin': 'darwin-x86_64', 'Linux': 'linux-x86_64'}[platform.system()]
BIN = NDK / 'toolchains/llvm/prebuilt' / HOST / 'bin'
target = ROOT / 'app/src/main/jniLibs/arm64-v8a/libdshlandlock.so'
target.parent.mkdir(parents=True, exist_ok=True)
subprocess.run([str(BIN / 'aarch64-linux-android28-clang'), '-O2', '-fPIE', '-pie',
                str(ROOT / 'native/landlock-run.c'), '-Wl,-z,max-page-size=16384',
                '-o', str(target)], check=True)
subprocess.run([str(BIN / 'llvm-strip'), '--strip-unneeded', str(target)], check=True)
print('Built Android Landlock launcher:', target.stat().st_size, 'bytes')
