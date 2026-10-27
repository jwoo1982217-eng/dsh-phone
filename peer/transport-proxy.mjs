import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const loopback = host => host === 'localhost' || host === '::1' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'));
const read = (env, name) => env[name.toLowerCase()] ?? env[name] ?? '';
function bypass(url, value) {
  if (loopback(url.hostname)) return true;
  return String(value).split(/[\s,]+/).filter(Boolean).some(entry => {
    if (entry === '*') return true;
    let host = entry.toLowerCase(), port;
    const match = host.match(/^(.*):(\d+)$/);
    if (match && !host.startsWith('[')) { host = match[1]; port = match[2]; }
    if (port && port !== (url.port || (url.protocol === 'https:' ? '443' : '80'))) return false;
    host = host.replace(/^\*?\./, '');
    return url.hostname.toLowerCase() === host || url.hostname.toLowerCase().endsWith('.' + host);
  });
}
export function environmentRoute(url, env = process.env) {
  if (bypass(url, read(env, 'NO_PROXY'))) return { proxied: false };
  const proxy = read(env, url.protocol === 'https:' ? 'HTTPS_PROXY' : 'HTTP_PROXY') || read(env, 'ALL_PROXY') || (url.protocol === 'https:' ? read(env, 'HTTP_PROXY') : '');
  return proxy ? { proxied: true, proxy } : { proxied: false };
}
export async function runtimeRoute(url, { loadSdk = () => import('@deepseek-ai/dsh-http-proxy'), env = process.env } = {}) {
  let sdk;
  try { sdk = await loadSdk(); }
  catch (error) {
    if (!['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error;
  }
  return typeof sdk?.proxyRouteFor === 'function' ? sdk.proxyRouteFor(url) : environmentRoute(url, env);
}
export function nativeProxySupported(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major >= 25 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}
// ws does not use undici's dispatcher. Snapshot the SDK's selected route and
// give this connection its own native Agent; never change the global agents.
export async function transportOptions(value, { routeFor = runtimeRoute, nodeVersion } = {}) {
  const url = new URL(value);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol === 'ws:') url.protocol = 'http:';
  const route = loopback(url.hostname) ? { proxied: false } : await routeFor(url);
  let proxyEnv = {};
  if (route.proxied) {
    if (!nativeProxySupported(nodeVersion)) throw Object.assign(Error('代理需要更新 Node 运行时'), { code: 'PEER_PROXY_UNSUPPORTED' });
    let proxy;
    try { proxy = new URL(route.proxy); if (!['http:', 'https:'].includes(proxy.protocol)) throw Error(); }
    catch { throw Object.assign(Error('代理配置不可用'), { code: 'PEER_PROXY_INVALID' }); }
    proxyEnv = { HTTP_PROXY: proxy.href, HTTPS_PROXY: proxy.href, NO_PROXY: '' };
  }
  const Agent = url.protocol === 'https:' ? https.Agent : http.Agent;
  const agent = new Agent({ proxyEnv, keepAlive: false });
  return { agent, release: () => agent.destroy() };
}
