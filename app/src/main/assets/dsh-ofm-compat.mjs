/** APK-owned OFM adaptation. Program files only; account data is never read. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DATA = JSON.parse(fs.readFileSync(new URL('./dsh-ofm-compat-data.json', import.meta.url), 'utf8'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const MARKER = '// dsh-phone: preserve OFM compatibility before reload';
const RELOAD_HOOK = `      ${MARKER}
      if (process.env.DSH_PHONE_ANDROID === '1') {
        const files = String(process.env.DSH_PHONE_FILES ?? '')
        if (/^\\/data\\/(?:user\\/0|data)\\/com\\.dshphone\\/files$/.test(files)) {
          try {
            const revision = Math.max(...['dsh-ofm-compat.mjs', 'dsh-ofm-compat-data.json'].map(name => fs.statSync(files + '/' + name).mtimeMs))
            const phone = await import('file://' + files + '/dsh-ofm-compat.mjs?revision=' + revision)
            phone.applyPhoneCompatibility(fileURLToPath(packageUrl))
          } catch (error) {
            return { ok: false, error: 'Android OFM compatibility: ' + String(error?.message ?? error).slice(0, 160), restored: true }
          }
        }
      }
`;
function replaceOnce(text, before, after, label) {
  if (text.split(before).length !== 2) throw Error('Unsupported OFM shape: ' + label);
  return text.replace(before, after);
}
function functionRange(text, name, indent = '    ', exported = false) {
  const start = text.indexOf(indent + (exported ? 'export ' : '') + 'function ' + name + '(');
  const end = text.indexOf('\n' + indent + '}', start) + indent.length + 2;
  if (start < 0 || end <= start) throw Error('Unsupported OFM function: ' + name);
  return { start, end, value: text.slice(start, end) };
}
function replaceFunction(text, name, rule, indent = '    ', exported = false) {
  const found = functionRange(text, name, indent, exported);
  const replacement = rule.variants?.[sha(found.value)] ?? (rule.accepted?.includes(sha(found.value)) ? rule.replacement : undefined);
  if (replacement === undefined) throw Error('Unreviewed OFM function: ' + name);
  return text.slice(0, found.start) + replacement + text.slice(found.end);
}
function routeCaller(text, name, before, after) {
  const found = functionRange(text, name);
  if (found.value.includes(after)) return text;
  const replacement = replaceOnce(found.value, before, after, name + ' RPC');
  return text.slice(0, found.start) + replacement + text.slice(found.end);
}
export function planPhoneCompatibility(files) {
  const manifest = JSON.parse(files['package.json']);
  if (manifest.name !== 'dsh-our-free-model') throw Error('Not an OFM package');
  if (!DATA.reviewedVersions.includes(manifest.version)) throw Error('Unreviewed OFM version: ' + manifest.version);
  const RULES = DATA.versionRules?.[manifest.version] ?? DATA;
  const next = { ...files };
  let index = files['index.js'];
  const mountStart = index.indexOf("  let channelPack = { state: 'pending', error: '' }");
  const mountEnd = index.indexOf('\n  const logAdmissionRejection', mountStart);
  const oldMount = index.slice(mountStart, mountEnd);
  const mountReplacement = RULES.mount.variants?.[sha(oldMount)] ?? (RULES.mount.accepted?.includes(sha(oldMount)) ? RULES.mount.replacement : undefined);
  if (mountStart < 0 || mountEnd < mountStart || mountReplacement === undefined) throw Error('Unreviewed OFM channel registration');
  index = index.slice(0, mountStart) + mountReplacement + index.slice(mountEnd);
  if (!index.includes("import { mountHostChannels } from './src/host-channels.js'")) {
    index = replaceOnce(index, "import { createModelRuntime, createRuntimeStores } from './src/core/runtime.js'", "import { createModelRuntime, createRuntimeStores } from './src/core/runtime.js'\nimport { mountHostChannels } from './src/host-channels.js'", 'runtime import');
  }
  if (files['src/host-channels.js'] !== undefined && files['src/host-channels.js'] !== RULES.hostChannels) throw Error('Existing host channel adapter differs');
  next['src/host-channels.js'] = RULES.hostChannels;
  if (files['src/open-external.js'] !== undefined) {
    const external = files['src/open-external.js'];
    const replacement = RULES.externalModule.variants?.[sha(external)] ?? (RULES.externalModule.accepted?.includes(sha(external)) ? RULES.externalModule.replacement : undefined);
    if (replacement === undefined) throw Error('Unreviewed OFM external launcher');
    next['src/open-external.js'] = replacement;
    next['index.js'] = index;
  } else next['index.js'] = replaceFunction(index, 'openExternal', RULES.external, '');

  let vault = files['src/vault.js'];
  vault = replaceFunction(vault, 'detectSealedHost', RULES.gate, '', true);
  if (!vault.includes("export const FLAVOR_PHONE = 'phone'")) vault = replaceOnce(vault, "export const FLAVOR_WEB = 'web'", "export const FLAVOR_WEB = 'web'\nexport const FLAVOR_PHONE = 'phone'", 'phone flavor');
  next['src/vault.js'] = vault;

  let client = files['client.js'];
  for (const name of ['useEacLogin', 'EacAuth', 'useChannelRpc']) client = replaceFunction(client, name, RULES.functions[name]);
  client = routeCaller(client, 'ChannelsPage', 'useChannelRpc(ctx)', 'useChannelRpc(ctx, summary)');
  client = routeCaller(client, 'useLedger', 'useChannelRpc(props.ctx)', 'useChannelRpc(props.ctx, props.summary)');
  client = routeCaller(client, 'GatewayPage', 'useChannelRpc(ctx)', 'useChannelRpc(ctx, props.summary)');
  client = routeCaller(client, 'GatewayPage', "try { setStatus(await rpc('gateway.getEnabled', {}, 30_000)) }", "try { setStatus(await rpc('gateway.getEnabled', {}, 30_000)); setNotice('') }");
  for (const name of ['ChannelsPage', 'LedgerPage', 'LogsPage', 'GatewayPage']) {
    const after = `h(${name}, { t, ctx, summary: data })`;
    const before = name === 'ChannelsPage' ? `h(${name}, { t, ctx, summary })` : `h(${name}, { t, ctx })`;
    client = routeCaller(client, 'Shell', before, after);
  }
  if (!client.includes("['free', t('nav.tab.free'), freeCatalog(data.catalog).length]")) {
    client = routeCaller(client, 'Shell', "['free', t('nav.tab.free'), counts.available ?? 0]", "['free', t('nav.tab.free'), data.catalog.filter(m => !m.channel || m.channel === 'kilo').length]");
  }
  for (const rule of RULES.freeCopy) {
    if (client.includes(rule.after)) continue;
    const before = rule.before.find(text => client.includes(text));
    if (before === undefined) throw Error('Unreviewed free model copy');
    client = replaceOnce(client, before, rule.after, 'free directory copy');
  }
  if (!client.includes('    function EacStatusPill(')) client = replaceOnce(client, '    function EacAuth(props) {', RULES.statusPill + '\n\n    function EacAuth(props) {', 'EAC status pill');
  const oldPill = "              h(Pill, { strong: true, tone: eacAuth?.authorized === true ? 'ok' : 'warn' },\n                eacAuth?.authorized === true ? t('eac.pillOk') : t('eac.pillLocked')),";
  if (client.includes(oldPill)) client = replaceOnce(client, oldPill, '              h(EacStatusPill, { auth: eacAuth, t }),', 'EAC hero status');
  if (!client.includes("'eac.open':")) {
    client = replaceOnce(client, "        'eac.copy': '复制链接',", "        'eac.open': '打开授权页面',\n        'eac.copy': '复制链接',", 'Chinese login link');
    client = replaceOnce(client, "        'eac.copy': 'Copy link',", "        'eac.open': 'Open authorization page',\n        'eac.copy': 'Copy link',", 'English login link');
  }
  if (!client.includes("'eac.pillUnavailable':")) {
    client = replaceOnce(client, "        'eac.pillLocked': '未授权',", "        'eac.pillUnavailable': '当前环境不可用',\n        'eac.pillLocked': '未授权',", 'Chinese unavailable state');
    client = replaceOnce(client, "        'eac.pillLocked': 'not authorized',", "        'eac.pillUnavailable': 'unavailable in this environment',\n        'eac.pillLocked': 'not authorized',", 'English unavailable state');
  }
  client = client.replace("'eac.sub': '桌面端协付渠道：GitHub 登录并 star 本仓库后解锁，与免费车道互不影响。'", "'eac.sub': '本机独立连接 EAC：GitHub 登录并 star 本仓库后解锁，与免费车道互不影响。'")
    .replace("'eac.sub': 'The desktop co-paid lane: unlocked by a GitHub login plus a star, independent of the free lane.'", "'eac.sub': 'This device connects to EAC independently: sign in with GitHub and star the repository to unlock.'");
  if (!client.includes('/* dsh-phone opaque settings surface */')) client = replaceOnce(client, '    const CSS = `', '    const CSS = `\n' + RULES.css, 'opaque mobile settings');
  if (!client.includes('EacAuth, EacStatusPill,')) client = replaceOnce(client, 'useEacLogin, EacAuth,', 'useEacLogin, EacAuth, EacStatusPill,', 'EAC test seam');
  if (!client.includes('useChannelRpc, sharedPushSource') && !client.includes('EacStatusPill, useChannelRpc,')) client = replaceOnce(client, 'EacAuth, EacStatusPill,', 'EacAuth, EacStatusPill, useChannelRpc,', 'channel test seam');
  if (manifest.version === '2.5.7') {
    if (client.includes('    function sharedPushSource(')) {
      if (functionRange(client, 'sharedPushSource').value !== RULES.sharedPush) throw Error('Unreviewed OFM shared push source');
    } else client = replaceOnce(client, '    function apply(ctx) {', RULES.sharedPush + '\n\n    function apply(ctx) {', 'shared SSE lease');
    if (!client.includes('source = sharedPushSource(`${API}/events`)')) client = replaceOnce(client, 'source = new EventSource(`${API}/events`)', 'source = sharedPushSource(`${API}/events`)', 'shared SSE source');
    if (!client.includes('CSS, EacStatusPill, sharedPushSource }')) {
      if (!client.includes('sharedPushSource }')) client = replaceOnce(client, 'Shell, CSS }', 'Shell, CSS, sharedPushSource }', 'shared SSE test seam');
    }
  }
  next['client.js'] = client;

  let reload = files['src/reload.js'];
  if (!reload.includes("const clientModules = typeof ctx.get === 'function'")) reload = replaceOnce(reload, '    const registry = ctx.registry', "    const registry = ctx.registry\n    const clientModules = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined", 'client cache service');
  if (!reload.includes("clientModules?.rebuilt?.('dsh-our-free-model')")) {
    reload = replaceOnce(reload, '      await Promise.all(created.map(fiber => fiber.await()))', "      await Promise.all(created.map(fiber => fiber.await()))\n      const clientRevision = clientModules?.rebuilt?.('dsh-our-free-model')", 'client publication');
    reload = replaceOnce(reload, 'fibers: created.length }', 'fibers: created.length, clientRevision }', 'client revision result');
  }
  if (reload.includes(MARKER)) {
    const start = reload.lastIndexOf('\n', reload.indexOf(MARKER)) + 1;
    const end = reload.indexOf('    const loader = ctx.loader', start);
    if (end <= start) throw Error('Unsupported existing phone reload hook');
    reload = reload.slice(0, start) + RELOAD_HOOK + reload.slice(end);
  } else reload = replaceOnce(reload, '    const loader = ctx.loader', RELOAD_HOOK + '    const loader = ctx.loader', 'phone reload preparation');
  next['src/reload.js'] = reload;
  return { version: manifest.version, files: next };
}

/** Validate the entire plan before atomic replacements, restoring on any IO failure. */
export function applyPhoneCompatibility(packageDir, { io = fs, checkSyntax = true } = {}) {
  const names = ['package.json', 'index.js', 'client.js', 'src/vault.js', 'src/reload.js', 'src/host-channels.js', 'src/open-external.js'];
  const originals = {};
  for (const name of names) {
    const file = path.join(packageDir, name);
    if (io.existsSync(file)) originals[name] = io.readFileSync(file, 'utf8');
    else if (!['src/host-channels.js', 'src/open-external.js'].includes(name)) throw Error('Incomplete OFM program: ' + name);
  }
  const plan = planPhoneCompatibility(originals);
  const changed = Object.keys(plan.files).filter(name => name !== 'package.json' && plan.files[name] !== originals[name]);
  const temporary = new Map();
  const applied = [];
  const backups = new Map();
  let restored = true;
  try {
    for (const name of changed) {
      const file = path.join(packageDir, name + '.phone-compat.mjs');
      io.writeFileSync(file, plan.files[name], { mode: 0o600 });
      temporary.set(name, file);
      if (checkSyntax) {
        const checked = spawnSync(process.execPath, ['--check', file], { timeout: 10_000, encoding: 'utf8' });
        if (checked.status !== 0) throw Error('Invalid generated OFM program: ' + name);
      }
    }
    // Allocate every backup before replacing any program file. Rollback then
    // uses rename, so it does not require free space for rewriting old sources.
    for (const name of changed) {
      if (originals[name] === undefined) continue;
      const backup = path.join(packageDir, name + '.phone-compat.before');
      io.copyFileSync(path.join(packageDir, name), backup);
      backups.set(name, backup);
    }
    for (const name of changed) {
      io.renameSync(temporary.get(name), path.join(packageDir, name));
      applied.push(name);
    }
  } catch (error) {
    for (const name of applied.reverse()) {
      const file = path.join(packageDir, name);
      try {
        if (originals[name] === undefined) io.unlinkSync(file);
        else io.renameSync(backups.get(name), file);
      } catch (restoreError) {
        restored = false;
        throw new Error('Phone compatibility rollback retained backups: ' + restoreError.message);
      }
    }
    throw error;
  } finally {
    for (const file of temporary.values()) { try { if (io.existsSync(file)) io.unlinkSync(file); } catch {} }
    if (restored) for (const file of backups.values()) { try { if (io.existsSync(file)) io.unlinkSync(file); } catch {} }
  }
  return { state: 'ready', version: plan.version, changed };
}

function isEntryModule() {
  if (!process.argv[1]) return false;
  try {
    // Node resolves the module URL through Android's /data/data alias while
    // argv retains the caller's /data/user/0 spelling (or vice versa).
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  try {
    const home = process.env.DSH_HOME;
    if (process.env.DSH_PHONE_ANDROID !== '1' || !home) throw Error('Android runtime required');
    const root = path.join(home, 'profiles/phone/node_modules/dsh-our-free-model');
    console.log(JSON.stringify({ ofmPhoneCompatibility: applyPhoneCompatibility(root) }));
  } catch (error) {
    console.error(JSON.stringify({ ofmPhoneCompatibility: { state: 'failed', error: String(error.message).slice(0, 200) } }));
    process.exitCode = 1;
  }
}
