import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigError } from './config.js';
export const SETUP_REF = 'DSH_PHONE_QQ_SETUP';
export const QQ_PORT = 16301, QQ_WEB_PORT = 16099;
const hex = () => randomBytes(32).toString('hex');
const shell = value => "'" + value.replaceAll("'", "'\\''") + "'";
const qqDownloader = readFileSync(new URL('./qq-download.py', import.meta.url), 'utf8');
export function qqStartScript() {
  return `#!/data/data/com.termux/files/usr/bin/bash
set -e
termux-wake-lock || true
# screen can leave an older PRoot/QQ tree behind. Stop only this dedicated
# container, matching the actual executable and container path, not other apps.
for file in /proc/[0-9]*/cmdline; do
  [ -r "$file" ] || continue
  args=$(tr '\\0' '\\n' < "$file" 2>/dev/null) || continue
  first=$(printf '%s\\n' "$args" | head -n 1)
  case "\${first##*/}" in proot) ;; *) continue ;; esac
  if printf '%s\\n' "$args" | grep -F 'containers/dsh-qq/' >/dev/null; then
    pid=\${file#/proc/}; pid=\${pid%/cmdline}
    # PRoot ignores SIGTERM. SIGQUIT runs its tracee cleanup before exit.
    kill -QUIT "$pid" 2>/dev/null || true
  fi
done
screen -S dsh-qq -X quit 2>/dev/null || true
for ((attempt=0; attempt<20; attempt++)); do
  if ! curl --silent --fail --max-time 1 http://127.0.0.1:${QQ_WEB_PORT}/webui/ >/dev/null; then break; fi
  sleep 1
done
if curl --silent --fail --max-time 1 http://127.0.0.1:${QQ_WEB_PORT}/webui/ >/dev/null; then
  printf '原 QQ 登录端仍在退出，请稍后重试启动。\\n' >&2
  exit 1
fi
screen -dmS dsh-qq proot-distro login dsh-qq -- bash -c 'xvfb-run -a /root/Napcat/opt/QQ/qq --no-sandbox'
`;
}
export function qqRestartScript(record) {
  return `#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
umask 077
${writeConfigScript(record)}
mkdir -p "$HOME/.local/share/dsh-phone"
cat > "$HOME/.local/share/dsh-phone/qq-start.sh" <<'DSH_START'
${qqStartScript()}
DSH_START
bash "$HOME/.local/share/dsh-phone/qq-start.sh"
printf 'QQ 登录端正在启动，回到 DSH 查看二维码。\\n'
`;
}
export function napcatInstallerScript() {
  return `set -euo pipefail
apt update
apt install -y sudo curl libgcrypt20 python3
# Each attempt has a fresh working directory. Preserve any old ~/NapCat
# extraction directory, which the upstream installer refuses to overwrite.
work=$(mktemp -d /tmp/dsh-napcat-install.XXXXXXXX)
cd "$work"
printf '正在继续安装 QQ 登录端，原来的解压目录会保留。\\n'
cat > qq-download.py <<'DSH_QQ_DOWNLOAD_PY'
${qqDownloader}
DSH_QQ_DOWNLOAD_PY
python3 ./qq-download.py
curl --fail --location --retry 3 https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.sh -o install.sh
python3 - <<'DSH_QQ_VERSION_PY'
from pathlib import Path
import re
version = Path('qq-version.txt').read_text().strip()
assert re.fullmatch(r'\\d+\\.\\d+\\.\\d+-\\d+', version), 'QQ version is invalid'
source = Path('install.sh').read_text()
source, count = re.subn(r'(?m)^([ \\t]*linuxqq_target_version=)"[^"\\n]+"[ \\t]*$', lambda m: m[1] + '"' + version + '"', source)
assert count == 1, 'NapCat installer changed; existing QQ environment is preserved'
# Replace the rootless extraction command too, otherwise it invokes GNU tar
# again after our successful staging validation and repeats the phone failure.
old = 'execute_command "dpkg -x ./'+chr(36)+'{qq_package_file} '+chr(36)+'{INSTALL_BASE_DIR}" "解压QQ (.deb)"'
assert source.count(old) == 1, 'NapCat QQ extraction changed; existing environment is preserved'
source = source.replace(old, 'execute_command "python3 ./qq-download.py --extract-deb ./'+chr(36)+'{qq_package_file} '+chr(36)+'{INSTALL_BASE_DIR}" "解压QQ (.deb)"')
Path('install.sh').write_text(source)
DSH_QQ_VERSION_PY
if [ -d "$HOME/Napcat" ]; then
  cp -a "$HOME/Napcat" "$work/previous-Napcat"
  printf '原 QQ 安装文件已备份。\\n'
fi
if ! bash ./install.sh --docker n --cli n --proxy 0; then
  printf 'QQ 安装未完成；安装前的文件保留在本次工作目录中。\\n' >&2
  exit 1
fi
`;
}
function writeConfigScript(record) {
  const onebot = JSON.stringify({ network: { httpServers: [], httpClients: [], websocketClients: [],
    websocketServers: [{ name: 'dsh-phone', enable: true, host: '127.0.0.1', port: QQ_PORT, token: record.token,
      messagePostFormat: 'array', reportSelfMessage: false, enableForcePushEvent: true, heartInterval: 30000, debug: false }] } });
  const webui = JSON.stringify({ host: '127.0.0.1', port: QQ_WEB_PORT, token: record.webToken, autoLoginAccount: String(record.selfId) });
  return `proot-distro login dsh-qq -- /bin/bash -s <<'DSH_CONFIG'
set -euo pipefail
config="/root/Napcat/opt/QQ/resources/app/app_launcher/napcat/config"
test -x /root/Napcat/opt/QQ/qq
test -f /root/Napcat/opt/QQ/resources/app/app_launcher/napcat/napcat.mjs
mkdir -p "$config"
for name in onebot11_${record.selfId}.json webui.json; do
  if [ -f "$config/$name" ]; then cp "$config/$name" "$config/$name.dsh-backup-$(date +%s)"; fi
done
printf '%s' ${shell(onebot)} > "$config/onebot11_${record.selfId}.json"
printf '%s' ${shell(webui)} > "$config/webui.json"
DSH_CONFIG`;
}
export function installerScript(record) {
  return `#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
umask 077
printf '正在准备手机 QQ 登录环境。首次安装会下载 Linux 和 QQ 资源，请保持网络连接。\\n'
pkg update -y
pkg install -y proot-distro screen curl
runtime="$PREFIX/var/lib/proot-distro"
# v5 stores containers here; v4 rootfs directories migrate on the first login.
# The human-readable list is printed to stderr by v5, so do not parse it.
if [ -d "$runtime/containers/dsh-qq/rootfs" ] || [ -d "$runtime/installed-rootfs/dsh-qq" ]; then
  printf '已找到手机 QQ 环境，继续安装，不重复创建。\\n'
else
  proot-distro install debian --override-alias dsh-qq
fi
if ! proot-distro login dsh-qq -- /bin/true; then
  printf '手机 QQ 环境暂时无法启动；已保留原环境。请把上面的错误发给维护者。\\n' >&2
  exit 1
fi
if ! proot-distro login dsh-qq -- /bin/bash -c 'test -x /root/Napcat/opt/QQ/qq && test -f /root/Napcat/opt/QQ/resources/app/app_launcher/napcat/napcat.mjs && command -v xvfb-run >/dev/null'; then
  proot-distro login dsh-qq -- bash -c ${shell(napcatInstallerScript())}
fi
# Write through the guest interface, independent of its host-side storage layout.
${writeConfigScript(record)}
mkdir -p "$HOME/.local/share/dsh-phone"
cat > "$HOME/.local/share/dsh-phone/qq-start.sh" <<'DSH_START'
${qqStartScript()}
DSH_START
bash "$HOME/.local/share/dsh-phone/qq-start.sh"
for ((attempt=0; attempt<120; attempt++)); do
  if curl --silent --fail --max-time 2 http://127.0.0.1:${QQ_WEB_PORT}/webui/ >/dev/null; then
    curl --silent --show-error --fail --max-time 15 -H 'Origin: http://127.0.0.1:3080' -H 'Content-Type: application/json' --data ${shell(JSON.stringify({ type: 'client-request', rpcId: hex(), method: 'manage', payload: { action: 'qq.setup.complete', nonce: record.nonce } }))} http://127.0.0.1:3080/phone-import/manage > "$HOME/.local/share/dsh-phone/setup-result.json"
    if ! grep -q '"result":{"ok":true' "$HOME/.local/share/dsh-phone/setup-result.json"; then
      printf '登录端已安装，但机器人配置已在其他页面变更。返回 DSH 保存设置后重新连接。\\n' >&2
      exit 1
    fi
    printf '手机 QQ 登录端已启动。返回 DSH，点击“打开 QQ 登录页”，完成 QQ 授权后启动机器人。\\n'
    exit 0
  fi
  sleep 2
done
printf 'QQ 登录页未就绪，请在 Termux 查看安装输出，或返回 DSH 重新启动登录端。\\n' >&2
exit 1
`;
}
export class QQSetup {
  constructor(store, manager) { this.store = store; this.manager = manager; this.record = null; this.queue = Promise.resolve(); }
  mutate(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  async init() {
    const raw = await this.store.get(SETUP_REF); if (!raw) return;
    const r = JSON.parse(raw);
    if (!['prepared', 'installed'].includes(r.phase) || !/^[a-f0-9]{64}$/.test(r.token) || !/^[a-f0-9]{64}$/.test(r.webToken) || !Number.isSafeInteger(r.selfId) || !Number.isSafeInteger(r.revision) || !Number.isFinite(r.expires) || (r.phase === 'prepared' && !/^[a-f0-9]{64}$/.test(r.nonce))) throw new ConfigError('QQ 安装状态无法读取，请重试');
    this.record = r;
  }
  async persist(record) { await this.store.set(SETUP_REF, JSON.stringify(record)); this.record = record; }
  status() {
    const record = this.record;
    if (!record) return { phase: 'not-installed' };
    return { phase: record.phase === 'prepared' && Date.now() > record.expires ? 'expired' : record.phase,
      ...(record.phase === 'installed' ? { loginUrl: `http://127.0.0.1:${QQ_WEB_PORT}/webui/?token=${record.webToken}` } : {}) };
  }
  prepare() { return this.mutate(async () => {
    const state = await this.manager.status();
    if (!state.configured) throw new ConfigError('请先填写机器人和管理员 QQ 号，再保存设置');
    if (this.record?.phase !== 'prepared' || this.record.revision !== state.revision || Date.now() > this.record.expires) {
      await this.persist({ phase: 'prepared', nonce: hex(), token: hex(), webToken: hex(),
        selfId: state.config.selfId, revision: state.revision, expires: Date.now() + 2 * 60 * 60 * 1000,
        ...(this.record?.selfId === state.config.selfId ? { token: this.record.token, webToken: this.record.webToken } : {}) });
    }
    return { nonce: this.record.nonce };
  }); }
  script(nonce) {
    if (this.record?.phase !== 'prepared' || nonce !== this.record.nonce || Date.now() > this.record.expires) throw new ConfigError('安装请求已过期，请从机器人页面重新开始');
    return installerScript(this.record);
  }
  restartScript() {
    if (this.record?.phase !== 'installed') throw new ConfigError('请先安装手机 QQ 登录端');
    return qqRestartScript(this.record);
  }
  complete(nonce) { return this.mutate(async () => {
    const r = this.record;
    if (!r || nonce !== r.nonce || r.phase !== 'prepared' || Date.now() > r.expires) throw new ConfigError('安装回执无效或已过期');
    const state = await this.manager.status();
    await this.manager.save(JSON.stringify({ ...state.config, connection: { mode: 'forward', url: `ws://127.0.0.1:${QQ_PORT}` }, accessToken: r.token }), { revision: r.revision });
    await this.persist({ ...r, phase: 'installed', nonce: null });
    return this.status();
  }); }
}
