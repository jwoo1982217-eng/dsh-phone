import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ConfigError } from './config.js';
const privateAddress = address => {
  if (address.includes(':')) return address === '::' || address === '::1' || /^f[cd]|^fe[89ab]|^::ffff:/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};
async function publicUrl(value) {
  let url; try { url = new URL(value); } catch { throw new ConfigError('请输入完整网页地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ConfigError('网页地址须为 HTTP 或 HTTPS，不能包含账号密码');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => privateAddress(a.address))) throw new ConfigError('网页抓取只访问公开网站，不能访问手机管理服务或内网');
  return url;
}
export async function phoneWebFetch(value) {
  const signal = AbortSignal.timeout(15000); let url = await publicUrl(value);
  for (let redirect = 0; redirect < 5; redirect++) {
    const response = await fetch(url, { redirect: 'manual', signal });
    if ([301,302,303,307,308].includes(response.status)) { await response.body?.cancel(); const location = response.headers.get('location'); if (!location) throw new ConfigError('网页重定向缺少地址'); url = await publicUrl(new URL(location, url)); continue; }
    const kind = response.headers.get('content-type') || '';
    if (!/text|json|xml|javascript/i.test(kind)) { await response.body?.cancel(); throw new ConfigError('网页抓取支持文本、HTML、JSON 和 XML'); }
    const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; if (length > 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new ConfigError('网页正文超过 1 MB'); } chunks.push(chunk); }
    return JSON.stringify({ source: 'external-web-content', url: url.href, status: response.status, contentType: kind, content: Buffer.concat(chunks).toString('utf8') });
  }
  throw new ConfigError('网页重定向过多');
}
