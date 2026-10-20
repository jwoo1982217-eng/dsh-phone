/** Build an APK-owned compatibility snapshot from reviewed phone source. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const source = name => fs.readFileSync(path.join(root, 'our-free-model', name), 'utf8');
const upstream = JSON.parse(gunzipSync(fs.readFileSync(path.join(root, 'phone-compat/fixtures/upstream-2.5.1.json.gz'))));
const current = JSON.parse(gunzipSync(fs.readFileSync(path.join(root, 'phone-compat/fixtures/upstream-2.5.3.json.gz'))));
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function fn(text, name, indent = '    ', exported = false) {
  const token = indent + (exported ? 'export ' : '') + 'function ' + name + '(';
  const start = text.indexOf(token);
  const end = text.indexOf('\n' + indent + '}', start) + indent.length + 2;
  if (start < 0 || end <= start) throw Error('Missing reviewed function: ' + name);
  return text.slice(start, end);
}
function mount(text) {
  const start = text.indexOf("  let channelPack = { state: 'pending', error: '' }");
  const end = text.indexOf('\n  const logAdmissionRejection', start);
  if (start < 0 || end < start) throw Error('Missing reviewed channel mount');
  return text.slice(start, end);
}
const index = source('index.js'), client = source('client.js'), vault = source('src/vault.js');
const functions = {};
for (const name of ['useEacLogin', 'EacAuth', 'useChannelRpc']) {
  const replacement = fn(client, name);
  let latest = fn(current['client.js'], name);
  if (name === 'useEacLogin') latest = replacement.replace("post('/eac/login/start', undefined, 20_000)", "post('/eac/login/start', undefined, 30_000)");
  if (name === 'EacAuth') latest = latest.replace("          auth.authorized === true\n            ? h(Pill, { strong: true, tone: 'ok' }, t('eac.pillOk'))\n            : h(Pill, { strong: true, tone: 'warn' }, t('eac.pillLocked')),", '          h(EacStatusPill, { auth, t }),');
  if (name === 'useChannelRpc') latest = latest
    .replace('function useChannelRpc(ctx) {', 'function useChannelRpc(ctx, summary) {\n      const mode = summary?.channels?.mode')
    .replace("          const result = await latest.call.call(latest.connection.rpc, '/api', 'channel-pack', { method, payload }, controller.signal)", "          const channel = mode === 'shared' ? '/jet-hub' : '/api'\n          const endpoint = mode === 'shared' ? 'manage' : mode === 'shared-legacy' ? 'jet-hub' : 'channel-pack'\n          const result = await latest.call.call(latest.connection.rpc, channel, endpoint, { method, payload }, controller.signal)")
    .replace('[readTransport, transport])', '[readTransport, transport, mode])');
  if (latest === fn(current['client.js'], name)) throw Error('Missing 2.5.3 adaptation: ' + name);
  functions[name] = { variants: {
    [hash(fn(upstream['client.js'], name))]: replacement,
    [hash(replacement)]: replacement,
    [hash(fn(current['client.js'], name))]: latest,
    [hash(latest)]: latest,
  } };
}
const gate = fn(vault, 'detectSealedHost', '', true);
const external = fn(index, 'openExternal', '');
const externalModule = current['src/open-external.js'].replace('  if (url === null) return false', "  if (url === null) return false\n  // Android browser authorization is handled by the native WebView bridge.\n  if (platform === 'android' || process.env.DSH_PHONE_ANDROID === '1') return false");
const css = client.match(/\/\* dsh-phone opaque settings surface \*\/[\s\S]*?(?=\.ofm_root\{)/)?.[0];
if (!css) throw Error('Missing reviewed phone CSS');
const freeCopy = ['free.sub', 'free.tankLabel'].flatMap(key => {
  const entries = text => [...text.matchAll(new RegExp("        '" + key.replaceAll('.', '\\.') + "': [^\\n]+", 'g'))].map(m => m[0]);
  const phone = entries(client), old = entries(upstream['client.js']), latest = entries(current['client.js']);
  if (phone.length !== 2 || old.length !== 2 || latest.length !== 2) throw Error('Missing reviewed free copy: ' + key);
  return phone.map((after, i) => ({ after, before: [old[i], latest[i]] }));
});
const data = {
  format: 1,
  hostChannels: source('src/host-channels.js'),
  mount: { replacement: mount(index), accepted: [hash(mount(upstream['index.js'])), hash(mount(current['index.js'])), hash(mount(index))] },
  gate: { replacement: gate, accepted: [hash(fn(upstream['src/vault.js'], 'detectSealedHost', '', true)), hash(fn(current['src/vault.js'], 'detectSealedHost', '', true)), hash(gate)] },
  external: { replacement: external, accepted: [hash(fn(upstream['index.js'], 'openExternal', '')), hash(external)] },
  externalModule: { replacement: externalModule, accepted: [hash(current['src/open-external.js']), hash(externalModule)] },
  functions,
  statusPill: fn(client, 'EacStatusPill'),
  css,
  freeCopy,
};
fs.writeFileSync(path.join(root, 'app/src/main/assets/dsh-ofm-compat-data.json'), JSON.stringify(data) + '\n');
console.log('Built reviewed Android OFM compatibility data');
