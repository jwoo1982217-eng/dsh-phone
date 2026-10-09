import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installerScript, napcatInstallerScript } from './setup.js';

const record = { selfId: 100000001, token: 'a'.repeat(64), webToken: 'b'.repeat(64), nonce: 'c'.repeat(64) };
const guestQq = '/root/Napcat/opt/QQ';
const configRelative = 'root/Napcat/opt/QQ/resources/app/app_launcher/napcat/config';
function fixture(layout, ready = false, loginFail = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-qq-installer-'));
  const prefix = path.join(root, 'prefix'), home = path.join(root, 'home'), bin = path.join(root, 'bin');
  const runtime = path.join(prefix, 'var/lib/proot-distro');
  const guest = path.join(runtime, 'containers/dsh-qq/rootfs');
  const initial = layout === 'legacy' ? path.join(runtime, 'installed-rootfs/dsh-qq') : guest;
  for (const directory of [prefix, home, bin]) mkdirSync(directory, { recursive: true });
  if (layout !== 'absent') {
    mkdirSync(initial, { recursive: true }); writeFileSync(path.join(initial, 'keep.txt'), 'user data');
    const config = path.join(initial, configRelative); mkdirSync(config, { recursive: true });
    writeFileSync(path.join(config, 'webui.json'), '{"old":"keep a backup"}');
    if (ready) {
      const qq = path.join(initial, guestQq, 'qq'); writeFileSync(qq, 'existing QQ', { mode: 0o700 });
      writeFileSync(path.join(initial, 'root/Napcat/opt/QQ/resources/app/app_launcher/napcat/napcat.mjs'), 'existing NapCat');
    }
  }
  function mock(name, body) { writeFileSync(path.join(bin, name), '#!/bin/bash\nset -e\n' + body, { mode: 0o700 }); }
  mock('pkg', 'printf "pkg\\n" >> "$DSH_TEST_LOG"\n');
  mock('screen', 'printf "screen\\n" >> "$DSH_TEST_LOG"\nif [ "$1" = -dmS ]; then touch "$DSH_TEST_LOG.started"; fi\n');
  mock('termux-wake-lock', 'exit 0\n'); mock('xvfb-run', 'exit 0\n');
  mock('curl', `[ -f "$DSH_TEST_LOG.started" ] || exit 1\nprintf '%s' '{"result":{"ok":true}}'\n`);
  mock('proot-distro', `
printf '%s\\n' "$1" >> "$DSH_TEST_LOG"
if [ "$1" = install ]; then
  [ ! -d "$DSH_TEST_GUEST" ] || exit 71
  mkdir -p "$DSH_TEST_GUEST"
  exit 0
fi
[ "$1" = login ] || exit 72
[ "$DSH_TEST_LOGIN_FAIL" != 1 ] || exit 73
legacy="$DSH_TEST_PREFIX/var/lib/proot-distro/installed-rootfs/dsh-qq"
if [ -d "$legacy" ]; then mkdir -p "$(dirname "$DSH_TEST_GUEST")"; mv "$legacy" "$DSH_TEST_GUEST"; fi
[ -d "$DSH_TEST_GUEST" ] || exit 74
shift 2
[ "$1" = -- ] && shift
if [ "$1" = /bin/true ]; then exit 0; fi
if [ "$2" = -s ]; then
  script=$(cat)
  script=$(printf '%s' "$script" | sed "s|/root/Napcat|$DSH_TEST_GUEST/root/Napcat|g")
  /bin/bash -c "$script"
elif [[ "$3" = 'set -euo pipefail'* ]]; then
  printf 'napcat-install\\n' >> "$DSH_TEST_LOG"
  mkdir -p "$DSH_TEST_GUEST/root/Napcat/opt/QQ/resources/app/app_launcher/napcat"
  printf 'QQ' > "$DSH_TEST_GUEST/root/Napcat/opt/QQ/qq"
  chmod +x "$DSH_TEST_GUEST/root/Napcat/opt/QQ/qq"
  printf 'NapCat' > "$DSH_TEST_GUEST/root/Napcat/opt/QQ/resources/app/app_launcher/napcat/napcat.mjs"
else
  command="$3"
  command=$(printf '%s' "$command" | sed "s|/root/Napcat|$DSH_TEST_GUEST/root/Napcat|g")
  /bin/bash -c "$command"
fi
`);
  // Test-only home/prefix names prevent touching the real Termux or host home.
  const script = installerScript(record).replaceAll('$HOME', '$DSH_TEST_HOME').replaceAll('$PREFIX', '$DSH_TEST_PREFIX');
  const file = path.join(root, 'install.sh'); writeFileSync(file, script);
  const log = path.join(root, 'commands.log');
  return { root, initial, guest, log,
    run: () => execFileSync('/bin/bash', [file], { encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, DSH_TEST_HOME: home, DSH_TEST_PREFIX: prefix, DSH_TEST_GUEST: guest, DSH_TEST_LOG: log, DSH_TEST_LOGIN_FAIL: loginFail ? '1' : '0' } }),
    calls: () => readFileSync(log, 'utf8').trim().split('\n'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
test('installer reuses modern and migrated legacy containers and backs up guest configuration', () => {
  for (const layout of ['modern', 'legacy']) {
    const f = fixture(layout, layout === 'legacy');
    try {
      const output = f.run(); assert.match(output, /已找到手机 QQ 环境/);
      assert.equal(f.calls().includes('install'), false); assert.equal(f.calls().includes('list'), false);
      assert.equal(f.calls().filter(c => c === 'napcat-install').length, layout === 'legacy' ? 0 : 1);
      assert.equal(readFileSync(path.join(f.guest, 'keep.txt'), 'utf8'), 'user data');
      const config = path.join(f.guest, configRelative);
      assert.equal(JSON.parse(readFileSync(path.join(config, 'webui.json'))).port, 16099);
      assert.equal(JSON.parse(readFileSync(path.join(config, 'onebot11_100000001.json'))).network.websocketServers[0].port, 16301);
      const backup = readdirSync(config).find(n => n.startsWith('webui.json.dsh-backup-'));
      assert.equal(readFileSync(path.join(config, backup), 'utf8'), '{"old":"keep a backup"}');
      assert.equal(existsSync(path.join(f.root, 'prefix/var/lib/proot-distro/installed-rootfs/dsh-qq')), false);
    } finally { f.cleanup(); }
  }
});
test('installer creates a missing container once and continues through the private callback', () => {
  const f = fixture('absent');
  try { assert.match(f.run(), /手机 QQ 登录端已启动/); assert.equal(f.calls().filter(c => c === 'install').length, 1); assert.equal(f.calls().filter(c => c === 'napcat-install').length, 1); }
  finally { f.cleanup(); }
});
test('an existing container that cannot start is preserved without reinstalling or changing configuration', () => {
  const f = fixture('modern', false, true);
  try {
    assert.throws(f.run, error => error.status === 1 && /已保留原环境/.test(error.stderr));
    assert.equal(f.calls().includes('install'), false);
    assert.equal(readFileSync(path.join(f.guest, 'keep.txt'), 'utf8'), 'user data');
    assert.equal(readFileSync(path.join(f.guest, configRelative, 'webui.json'), 'utf8'), '{"old":"keep a backup"}');
  } finally { f.cleanup(); }
});
test('NapCat retries use separate empty working directories and preserve an older extraction', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-napcat-retry-'));
  try {
    const home = path.join(root, 'guest-home'), bin = path.join(root, 'bin'), workRoot = path.join(root, 'tmp');
    for (const directory of [home, bin, workRoot, path.join(home, 'NapCat')]) mkdirSync(directory, { recursive: true });
    const old = path.join(home, 'NapCat', 'keep.txt'); writeFileSync(old, 'previous extraction');
    const vendor = path.join(root, 'mock-vendor.sh');
    writeFileSync(vendor, `#!/bin/bash
set -e
linuxqq_target_version="3.2.30-50828"
[ "$linuxqq_target_version" = '3.2.30-50969' ] || exit 81
[ -f ./QQ.deb ] || exit 82
qq_package_file=QQ.deb
INSTALL_BASE_DIR="$PWD/target"
execute_command() { bash -c "$1"; }
execute_command "dpkg -x ./\${qq_package_file} \${INSTALL_BASE_DIR}" "解压QQ (.deb)"
if [ -d ./NapCat ] && [ "$(ls -A ./NapCat)" ]; then exit 79; fi
printf '%s\\n' "$PWD" >> "$DSH_TEST_ATTEMPTS"
mkdir ./NapCat
printf 'attempt data' > ./NapCat/data.txt
`);
    writeFileSync(path.join(bin, 'apt'), '#!/bin/bash\nexit 0\n', { mode: 0o700 });
    const python = execFileSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();
    writeFileSync(path.join(bin, 'python3'), `#!/bin/bash
set -e
if [ "$1" = './qq-download.py' ]; then
  if [ "\${2-}" = --extract-deb ]; then
    [ "$3" = ./QQ.deb ] || exit 83
    printf 'python-extract\\n' >> "$DSH_TEST_EXTRACTIONS"
    exit 0
  fi
  printf 'verified QQ fixture' > QQ.deb
  printf '3.2.30-50969' > qq-version.txt
  exit 0
fi
exec '${python}' "$@"
`, { mode: 0o700 });
    writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
set -e
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then cp "$DSH_TEST_VENDOR" "$2"; exit 0; fi
  shift
done
exit 80
`, { mode: 0o700 });
    const script = napcatInstallerScript().replace('/tmp/dsh-napcat-install.XXXXXXXX', path.join(workRoot, 'dsh-napcat-install.XXXXXXXX'));
    const log = path.join(root, 'attempts.log');
    const extractionLog = path.join(root, 'extractions.log');
    const options = { cwd: home, encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, DSH_TEST_VENDOR: vendor, DSH_TEST_ATTEMPTS: log, DSH_TEST_EXTRACTIONS: extractionLog } };
    for (let i = 0; i < 2; i++) execFileSync('/bin/bash', ['-c', script], options);
    const attempts = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(attempts.length, 2); assert.notEqual(attempts[0], attempts[1]);
    assert.deepEqual(readFileSync(extractionLog, 'utf8').trim().split('\n'), ['python-extract', 'python-extract']);
    for (const attempt of attempts) assert.ok(attempt.startsWith(workRoot + '/'));
    assert.equal(readFileSync(old, 'utf8'), 'previous extraction');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('failed QQ validation never invokes the upstream installer or modifies an existing installation', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-qq-download-failure-'));
  try {
    const bin = path.join(root, 'bin'), home = path.join(root, 'guest-home');
    for (const directory of [bin, home, path.join(home, 'Napcat')]) mkdirSync(directory, { recursive: true });
    const old = path.join(home, 'Napcat', 'keep.txt'); writeFileSync(old, 'existing QQ data');
    for (const [name, body] of [['apt', 'exit 0'], ['python3', 'exit 22'], ['curl', 'touch "$DSH_TEST_VENDOR_CALLED"; exit 0']]) {
      writeFileSync(path.join(bin, name), '#!/bin/bash\n' + body + '\n', { mode: 0o700 });
    }
    const called = path.join(root, 'called');
    const script = napcatInstallerScript().replace('/tmp/dsh-napcat-install.XXXXXXXX', path.join(root, 'dsh-napcat-install.XXXXXXXX'));
    assert.throws(() => execFileSync('/bin/bash', ['-c', script], { cwd: home, env: { ...process.env, PATH: bin + ':' + process.env.PATH, DSH_TEST_VENDOR_CALLED: called } }), e => e.status === 22);
    assert.equal(existsSync(called), false);
    assert.equal(readFileSync(old, 'utf8'), 'existing QQ data');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
