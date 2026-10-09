import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = 'http://127.0.0.1:16099/api';
const messages = {
  'not-installed': '先安装并启动 QQ 登录端，二维码会直接显示在这里。',
  unavailable: 'QQ 登录端暂时没有响应，请先启动手机 QQ 登录端。',
  'auth-error': 'QQ 登录端令牌验证失败，请重新连接登录端。',
  'verification-required': 'QQ 管理页启用了额外验证，请打开下方高级登录页完成验证。',
  waiting_qrcode: '请用机器人那个 QQ 号扫描下方二维码，并在 QQ 中确认登录。',
  qrcode_scanned: '二维码已扫描，请在 QQ 中确认登录。',
  initializing: 'QQ 已接受登录，正在启动连接服务…',
  reconnecting: 'QQ 登录服务正在恢复，准备好后会显示新的二维码。',
  offline: 'QQ 已掉线，请重新扫码登录。',
  ready: 'QQ 已登录。现在可以连接机器人。',
  expired: '二维码已过期，请点击「刷新二维码」。',
  error: 'QQ 登录未完成，请刷新二维码后重试。',
};
const result = (phase, extra = {}) => ({ phase, message: messages[phase] ?? messages.error, ...extra });
const image = async value => {
  // Reuse the pure-JS QR encoder already shipped with the QQ channel.
  const QRCode = createRequire(require.resolve('dsh-channel-qq'))('qrcode');
  return QRCode.toDataURL(value, { width: 320, margin: 4, errorCorrectionLevel: 'M' });
};
function qrUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'txz.qq.com' && u.pathname === '/p' &&
      !u.port && !u.username && !u.password && u.searchParams.has('k') ? u.href : null;
  } catch { return null; }
}
export class QQLogin {
  constructor(record, { fetch = globalThis.fetch, makeQr = image } = {}) {
    this.record = record; this.fetch = fetch; this.makeQr = makeQr;
    this.auth = null; this.qr = null; this.inflight = null;
  }
  async request(route, body, credential, signal) {
    const response = await this.fetch(api + route, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('local-api');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 65536) { await response.body.cancel().catch(() => {}); throw new Error('response-size'); }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  status(refresh = false) {
    if (this.inflight && !refresh) return this.inflight;
    const previous = this.inflight;
    const next = (async () => { if (previous) await previous; return this.read(refresh); })();
    this.inflight = next;
    void next.finally(() => { if (this.inflight === next) this.inflight = null; }).catch(() => {});
    return next;
  }
  async read(refresh) {
    const record = this.record();
    if (record?.phase !== 'installed') return result('not-installed');
    const token = record.webToken;
    const signal = AbortSignal.timeout(6000);
    try {
      if (!this.auth || this.auth.token !== token || this.auth.expires < Date.now()) {
        this.auth = null; this.qr = null;
        const reply = await this.request('/auth/login', { hash: createHash('sha256').update(token + '.napcat').digest('hex') }, null, signal);
        if (reply.data?.require2FA) return result('verification-required');
        if (reply.code !== 0 || typeof reply.data?.Credential !== 'string' || reply.data.Credential.length > 4096) return result('auth-error');
        this.auth = { token, credential: reply.data.Credential, expires: Date.now() + 60000 };
      }
      const credential = this.auth.credential;
      if (refresh) {
        const reply = await this.request('/QQLogin/RefreshQRcode', {}, credential, signal);
        if (reply.code !== 0) return result('error');
        this.qr = null;
      }
      const reply = await this.request('/QQLogin/CheckLoginStatus', {}, credential, signal);
      // Discard a reply if setup credentials changed while the request was running.
      if (this.record()?.webToken !== token) { this.auth = null; this.qr = null; return result('not-installed'); }
      if (reply.code !== 0 || !reply.data) { this.auth = null; return result('auth-error'); }
      const data = reply.data;
      if (data.isLogin === true && data.coreReady !== false) { this.qr = null; return result('ready'); }
      const phase = data.isOffline === true ? 'offline' : data.loginPhase;
      if (['qrcode_scanned', 'initializing', 'reconnecting'].includes(phase)) return result(phase);
      if (data.loginError) return result(/过期|失效|expired/i.test(String(data.loginError)) ? 'expired' : 'error');
      const url = qrUrl(data.qrcodeurl);
      if (!url) return result(phase === 'offline' ? 'offline' : 'reconnecting');
      if (this.qr?.url !== url) this.qr = { url, png: await this.makeQr(url) };
      if (this.record()?.webToken !== token) { this.auth = null; this.qr = null; return result('not-installed'); }
      return result(phase === 'offline' ? 'offline' : 'waiting_qrcode', { qrImage: this.qr.png });
    } catch { this.auth = null; return result('unavailable'); }
  }
}
