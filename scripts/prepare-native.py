"""Fetch verified Bionic shell/search libraries without running install scripts."""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile, urllib.request
ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT/'app/src/main/jniLibs/arm64-v8a'
PACKAGES = json.loads((ROOT/'native/termux-packages.json').read_text())
FILENAMES = {'bash':'bin/bash','readline':'lib/libreadline.so.8.3','ncurses':'lib/libncursesw.so.6.5','libandroid-support':'lib/libandroid-support.so','libiconv':'lib/libiconv.so','ripgrep':'bin/rg','pcre2':'lib/libpcre2-8.so'}
OUTPUTS = {'bash':'libbash.so','readline':'libreadline.so','ncurses':'libncursesw.so','libandroid-support':'libandroid-support.so','libiconv':'libiconv.so','ripgrep':'libdshrg.so','pcre2':'libpcre2-8.so'}
def main():
    TARGET.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='dsh-native-') as temporary:
        temp = Path(temporary)
        for item in PACKAGES:
            deb=temp/(item['Package']+'.deb')
            subprocess.run(['curl','--fail','--location','--retry','3','--retry-all-errors','--silent','--show-error','https://packages.termux.dev/apt/termux-main/'+item['Filename'],'-o',str(deb)],check=True)
            if hashlib.sha256(deb.read_bytes()).hexdigest()!=item['SHA256']: raise RuntimeError('Package checksum mismatch: '+item['Package'])
            unpack=temp/item['Package'];unpack.mkdir()
            data=deb.read_bytes()
            if not data.startswith(b'!<arch>\n'): raise RuntimeError('Not a deb ar archive')
            offset=8
            while offset<len(data):
                header=data[offset:offset+60];size=int(header[48:58]);name=header[:16].decode().strip().rstrip('/')
                if name in ('debian-binary','control.tar.xz','data.tar.xz','control.tar.zst','data.tar.zst','data.tar.gz'):
                    (unpack/name).write_bytes(data[offset+60:offset+60+size])
                offset+=60+size+(size%2)
            subprocess.run(['tar','-xf',str(next(unpack.glob('data.tar.*')))],cwd=unpack,check=True)
            binary=(unpack/'data/data/com.termux/files/usr'/FILENAMES[item['Package']]).read_bytes()
            # Android extracts only *.so. Equal-length edits retain ELF offsets.
            for old,new in [(b'libreadline.so.8\0',b'libreadline.so\0\0\0'),(b'libncursesw.so.6\0',b'libncursesw.so\0\0\0')]:
                assert len(old)==len(new);binary=binary.replace(old,new)
            destination=TARGET/OUTPUTS[item['Package']];destination.write_bytes(binary);destination.chmod(0o755)
    print('Prepared Android arm64 Bash, ripgrep and their libraries; Node is prepared separately.')
if __name__=='__main__':main()
