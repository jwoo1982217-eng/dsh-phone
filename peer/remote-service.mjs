import http from 'node:http';
import https from 'node:https';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { relayUrl, relayProof } from './protocol.mjs';
import { transportOptions } from './transport-proxy.mjs';

const REF = credentialRef('DSH_PEER_REMOTE_SERVICE_V1');
const messages = {
  PEER_SERVICE_CONFIG: '远程连接服务配置无效', PEER_SERVICE_NOT_CONFIGURED: '远程连接服务尚未配置，请联系电脑端维护者',
  PEER_SERVICE_TIMEOUT: '远程连接服务响应超时，请稍后重试', PEER_SERVICE_UNAVAILABLE: '远程连接服务暂时不可用，请稍后重试',
  PEER_SERVICE_AUTH: '远程连接服务授权未通过，请联系电脑端维护者', PEER_SERVICE_CONFLICT: '远程连接登记冲突，请重新生成连接链接',
  PEER_SERVICE_MISMATCH: '已保存配对属于其他中继，请明确重新生成链接', PEER_STORAGE: '设备配置未保存，原配对已保留',
  PEER_REVOKE_PENDING: '旧连接尚未撤销，请重试完成；配对恢复信息已保留',
  PEER_CLEANUP_PENDING: '新连接登记尚未清理，原配对已保留，请重试完成清理',
};
export function serviceError(code) { return Object.assign(Error(messages[code] || '设备操作未完成，请稍后重试'), { code }); }
function validate(value) {
  try {
    const relay = relayUrl(value.relay), url = new URL(relay);
    if (url.pathname !== '/relay' || typeof value.adminKey !== 'string' || value.adminKey.length < 16 || value.adminKey.length > 4096 || /[\r\n\s]/.test(value.adminKey)) throw Error();
    return { relay, adminKey: value.adminKey };
  } catch { throw serviceError('PEER_SERVICE_CONFIG'); }
}
export class RemoteService {
  #config = null; #credentials;
  constructor(credentials, { timeoutMs = 10000 } = {}) { this.#credentials = credentials; this.timeoutMs = timeoutMs; this.phase = 'unconfigured'; this.errorCode = ''; }
  async init() {
    try { const saved = (await this.#credentials.resolve(REF))?.value; if (saved) { this.#config = validate(JSON.parse(saved)); this.phase = 'ready'; } }
    catch { this.phase = 'failed'; this.errorCode = 'PEER_SERVICE_CONFIG'; }
  }
  status() { return { ready: !!this.#config, hostname: this.#config ? new URL(this.#config.relay).hostname : '', phase: this.phase, errorCode: this.errorCode }; }
  get relay() { if (!this.#config) throw serviceError('PEER_SERVICE_NOT_CONFIGURED'); return this.#config.relay; }
  matches(pair) { return !!this.#config && pair?.relay === this.#config.relay; }
  async configure(value) {
    const candidate = validate(value);
    await this.#request(candidate, '/health', 'GET');
    try { await this.#credentials.set(REF, JSON.stringify(candidate)); }
    catch { throw serviceError('PEER_STORAGE'); }
    this.#config = candidate; this.phase = 'ready'; this.errorCode = '';
    return this.status();
  }
  async register(pair) {
    if (!this.matches(pair)) throw serviceError(this.#config ? 'PEER_SERVICE_MISMATCH' : 'PEER_SERVICE_NOT_CONFIGURED');
    await this.#request(this.#config, '/admin/rooms', 'POST', { room: pair.room, proof: relayProof(pair) });
  }
  async revoke(pair) {
    if (!this.matches(pair)) throw serviceError(this.#config ? 'PEER_SERVICE_MISMATCH' : 'PEER_SERVICE_NOT_CONFIGURED');
    await this.#request(this.#config, '/admin/rooms/' + pair.room, 'DELETE');
  }
  async #request(config, path, method, body) {
    this.phase = method === 'GET' ? 'checking' : method === 'DELETE' ? 'revoking' : 'registering'; this.errorCode = '';
    const url = new URL(config.relay); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'; url.pathname = path;
    let options, request, deadline, expired = false;
    const timeout = new Promise((_, reject) => { deadline = setTimeout(() => { expired = true; request?.destroy(); reject(serviceError('PEER_SERVICE_TIMEOUT')); }, this.timeoutMs); deadline.unref(); });
    try {
      const operation = (async () => {
        options = await transportOptions(url);
        if (expired) { options.release(); throw serviceError('PEER_SERVICE_TIMEOUT'); }
        return new Promise((resolve, reject) => {
          const content = body ? JSON.stringify(body) : undefined;
          request = (url.protocol === 'https:' ? https : http).request(url, {
            method, agent: options.agent, headers: { ...(method === 'GET' ? {} : { Authorization: 'Bearer ' + config.adminKey }), ...(content ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(content) } : {}) },
          }, response => {
            // No redirects and no private service response text reaches the UI.
            response.resume();
            const status = response.statusCode;
            if (method === 'POST' ? [200, 201].includes(status) : status === 200) resolve();
            else reject(serviceError(status === 401 || status === 403 ? 'PEER_SERVICE_AUTH' : status === 409 ? 'PEER_SERVICE_CONFLICT' : 'PEER_SERVICE_UNAVAILABLE'));
          });
          request.on('error', () => reject(serviceError(expired ? 'PEER_SERVICE_TIMEOUT' : 'PEER_SERVICE_UNAVAILABLE')));
          request.end(content);
        });
      })();
      await Promise.race([operation, timeout]); this.phase = 'ready';
    } catch (error) { this.phase = 'failed'; this.errorCode = messages[error.code] ? error.code : 'PEER_SERVICE_UNAVAILABLE'; throw serviceError(this.errorCode); }
    finally { clearTimeout(deadline); options?.release(); }
  }
}
