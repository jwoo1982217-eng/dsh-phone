"""Build the pinned local Noema MCP engine using Rust and Android NDK r28c."""
from pathlib import Path
import os, platform, shutil, subprocess, tempfile
ROOT=Path(__file__).resolve().parents[1]
COMMIT='3db09452958dedf25aaeed3b445f40ac7054d8be'
NDK=Path(os.environ['ANDROID_NDK_HOME'])
HOST={'Darwin':'darwin-x86_64','Linux':'linux-x86_64'}[platform.system()]
BIN=NDK/'toolchains/llvm/prebuilt'/HOST/'bin'
subprocess.run(['rustup','target','add','aarch64-linux-android'],check=True)
with tempfile.TemporaryDirectory(prefix='dsh-noema-build-') as temporary:
    source=Path(temporary)/'noema'
    subprocess.run(['git','clone','https://github.com/ZSeven-W/noema',str(source)],check=True)
    subprocess.run(['git','checkout',COMMIT],cwd=source,check=True)
    cargo=source/'crates/noema-mcp/Cargo.toml'
    text=cargo.read_text();old='noema-core = { path = "../noema-core" }'
    if old not in text: raise RuntimeError('Pinned Noema dependency layout changed')
    cargo.write_text(text.replace(old,'noema-core = { path = "../noema-core", default-features = false }'))
    clang=str(BIN/'aarch64-linux-android28-clang')
    env={**os.environ,'RUSTFLAGS':f'--remap-path-prefix={Path.home()}=/build/user --remap-path-prefix={source}=/build/noema','CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER':clang,'CC_aarch64_linux_android':clang,'AR_aarch64_linux_android':str(BIN/'llvm-ar')}
    subprocess.run(['cargo','build','--locked','--release','-p','noema-mcp','--target','aarch64-linux-android'],cwd=source,env=env,check=True)
    target=ROOT/'app/src/main/jniLibs/arm64-v8a/libnoema.so';target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(source/'target/aarch64-linux-android/release/noema-mcp',target)
print('Built the local Android memory engine. Optional S3 support is excluded.')
