// Community adaptation by DeepSeek Stream. Original DSH package bytes and licences
// are copied only on the user's machine, never redistributed with this plugin.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { validateCommunityProfilePaths, assertCommunityLiveProfile, canonicalCommunityProfile } from './community-profile-paths.js';

const OWNER = 'dsh-purge-community-private-runtime-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root, value) => value === root || value.startsWith(root + path.sep);
const json = value => JSON.stringify(value, null, 2) + '\n';
function physicalDirectory(dir) {
  const value = path.resolve(dir);
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(value) !== value) throw new Error('Private runtime directory must be a physical directory: ' + value);
  return value;
}
function regularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file)) throw new Error('Private runtime file is not a regular physical file: ' + file);
  return stat;
}
function profileFacts(ctx) {
  const profile = canonicalCommunityProfile(ctx?.profileContext);
  if (!profile || typeof profile.dir !== 'string' || typeof profile.home !== 'string' || typeof profile.patchPath !== 'string') throw new Error('A launcher-owned current profile is required');
  const { dir, home, mode } = validateCommunityProfilePaths(profile, { requireLauncherFiles: true });
  const patchPath = path.resolve(profile.patchPath);
  if (fs.existsSync(patchPath)) regularFile(patchPath);
  return { profile, dir, home, mode, patchPath, ownerDir: path.join(dir, '.dsh-purge-runtime') };
}
function ensureOwner(facts) {
  if (!fs.existsSync(facts.ownerDir)) fs.mkdirSync(facts.ownerDir, { mode: 0o700 });
  physicalDirectory(facts.ownerDir);
  const marker = path.join(facts.ownerDir, 'owner.json');
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, json({ owner: OWNER, profileDir: facts.dir }), { flag: 'wx', mode: 0o600 });
  regularFile(marker);
  const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (saved.owner !== OWNER || saved.profileDir !== facts.dir) throw new Error('Private runtime directory belongs to a different owner');
}
function atomic(file, bytes) {
  if (fs.existsSync(file)) regularFile(file);
  const temporary = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); } catch (error) { fs.unlinkSync(temporary); throw error; }
}
async function withLock(facts, ctx, callback) {
  ensureOwner(facts);
  const libs = await profileLibraries(ctx, facts);
  // The client's native lock has owner/PID recovery and serialized reclamation.
  // Its separate owner lock serializes Apply/Revert; package.json uses the same
  // native lock as ConfigEditor and PluginManager during each commit below.
  return libs.withFileLock(path.join(facts.ownerDir, 'owner.json'), callback);
}
function readPatch(facts) { if (!fs.existsSync(facts.patchPath)) return ''; regularFile(facts.patchPath); return fs.readFileSync(facts.patchPath, 'utf8'); }
async function patchParser(facts) {
  const require = createRequire(facts.profile.installAnchor);
  const yaml = require('js-yaml');
  const include = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')).href);
  return text => yaml.load(text, { schema: include.entryListSchema });
}
function ownedBlock(state) { return '# BEGIN ' + OWNER + ' ' + state.token + '\n' + state.patchBody + '# END ' + OWNER + ' ' + state.token + '\n'; }
function rowPatchBody(rows) {
  const patches = [];
  for (const row of rows) {
    // alpha.1's patch.name validates identity rather than renaming a row.
    patches.push({ id: row.originalId, name: row.originalName, disabled: true });
    patches.push({ ...(row.parentId ? { id: row.parentId } : {}), insert: [row.clone] });
  }
  return patches.map(patch => '- ' + JSON.stringify(patch) + '\n').join('');
}
function validateState(facts, state) {
  if (!state || state.owner !== OWNER || state.profileDir !== facts.dir || !/^[0-9a-f-]{36}$/.test(state.token)) throw new Error('Invalid private runtime metadata');
  const runDir = path.join(facts.ownerDir, state.token);
  if (state.runDir !== runDir || state.aiBase !== path.join(runDir, 'node_modules', '@deepseek-ai')) throw new Error('Private runtime metadata escapes its owner directory');
  physicalDirectory(runDir); physicalDirectory(state.aiBase);
  if (hash(state.patchBody) !== state.patchBodySha256) throw new Error('Private runtime patch metadata changed');
  if (!Array.isArray(state.packages) || !Array.isArray(state.rows)) throw new Error('Private runtime ownership metadata is incomplete');
  for (const pkg of state.packages) {
    if (!/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(pkg.name) || pkg.privateDir !== path.join(state.aiBase, pkg.name.split('/')[1])) throw new Error('Private runtime package metadata escapes its generation');
    physicalDirectory(pkg.privateDir);
    if (!Array.isArray(pkg.copiedFiles) || pkg.copiedFiles.some(file => typeof file.relative !== 'string' || path.isAbsolute(file.relative) || file.relative.split(/[\\/]/).includes('..') || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error('Private runtime file metadata is invalid');
  }
  for (const row of state.rows) {
    if (!state.packages.some(pkg => inside(pkg.privateDir, row.privateFile)) || row.clone?.name !== pathToFileURL(row.privateFile).href || row.clone.id !== row.originalId) throw new Error('Private Loader row escapes its generation or changed its original ID');
    regularFile(row.privateFile);
  }
  if (state.overlayKind === 'bundle-alias') {
    if (!Array.isArray(state.bundleReplacements) || !Array.isArray(state.patchNameMappings)) throw new Error('Private bundle ownership metadata is incomplete');
    for (const item of state.bundleReplacements) {
      if (!new RegExp('^dsh-purge-private-' + state.token + '-bundle-[0-9]+$').test(item.alias)
        || item.aliasDir !== path.join(facts.dir, 'node_modules', item.alias)
        || item.aliasSource !== path.join(runDir, 'bundles', item.alias)
        || typeof item.aliasVersion !== 'string'
        || item.dependency !== 'file:' + path.relative(facts.dir, item.aliasSource).split(path.sep).join('/')) throw new Error('Private bundle metadata escapes its owner or changed its dependency');
      physicalDirectory(item.aliasSource);
    }
    for (const item of state.patchNameMappings) if (!state.rows.some(row => row.originalId === item.originalId && row.originalName === item.originalName && row.clone.name === item.privateName)) throw new Error('Private patch-name ownership metadata changed');
  }
  return state;
}
function selectedAliasIsOwned(facts, state, manifest, item) {
  if (manifest.dependencies?.[item.alias] !== item.dependency) return false;
  try {
    const packageDir = physicalDirectory(fs.realpathSync(item.aliasDir));
    if (!inside(facts.dir, packageDir)) return false;
    const file = path.join(packageDir, 'package.json'); regularFile(file);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved.name === item.alias && saved.version === item.aliasVersion
      && saved.deepseekStreamPrivateRuntime?.owner === OWNER
      && saved.deepseekStreamPrivateRuntime?.token === state.token
      && saved.deepseekStreamPrivateRuntime?.originalPackage === item.original;
  } catch { return false; }
}
export function currentPrivateOverlay(ctx) {
  const facts = profileFacts(ctx);
  // A candidate may contain a copied live owner file. Trial startup never
  // adopts, edits or reinterprets that live profile's private runtime state.
  if (facts.mode === 'trial') return undefined;
  if (!fs.existsSync(facts.ownerDir)) return undefined;
  ensureOwner(facts);
  const statePath = path.join(facts.ownerDir, 'current.json');
  if (!fs.existsSync(statePath)) return undefined;
  regularFile(statePath);
  const state = validateState(facts, JSON.parse(fs.readFileSync(statePath, 'utf8')));
  if (!['installed', 'prepared'].includes(state.phase)) return undefined;
  if (state.overlayKind === 'bundle-alias') {
    const manifestPath = path.join(facts.dir, 'package.json'); regularFile(manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const bundles = manifest.dsh?.profile?.bundles;
    if (!Array.isArray(bundles)) throw new Error('Current profile bundle list is invalid');
    const active = state.bundleReplacements.filter(item => bundles.includes(item.alias));
    const text = readPatch(facts);
    if (active.length !== state.bundleReplacements.length || active.some(item => !selectedAliasIsOwned(facts, state, manifest, item))) return { ...state, phase: 'partial', requiresRestore: true, active: false, profile: facts.profile };
    if (active.length || state.patchNameChanges?.some(item => text.includes(item.privateName))) return { ...state, phase: 'installed', recoveredCommit: state.phase === 'prepared', profile: facts.profile };
    return undefined;
  }
  throw new Error('Unsupported previous private runtime metadata; revert it with its matching adaptation');
}
function resolvedEntryUrl(ctx, entry, baseUrl) {
  const internal = ctx.loader?.internal;
  if (!internal) throw new Error('The running Loader must expose its actual module resolver');
  const result = internal.version === 'v2'
    ? internal.resolveSync(baseUrl, { specifier: entry.options.name, attributes: {} })
    : internal.resolveSync(entry.options.name, baseUrl, {});
  if (!result?.url?.startsWith('file:')) throw new Error('Core entry does not resolve to a local file');
  return result.url;
}
function copyPackage(source, destination, budget, sourceRoot = source) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('Core package contains a link; refusing shared writes or link traversal: ' + source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(source)) {
      if (name === 'node_modules' || name.endsWith('.dshpurge.bak')) continue;
      copyPackage(path.join(source, name), path.join(destination, name), budget, sourceRoot);
    }
  } else if (stat.isFile()) {
    if (++budget.files > 30000 || (budget.bytes += stat.size) > 256 * 1024 * 1024) throw new Error('Current runtime packages exceed the private copy limit');
    const bytes = fs.readFileSync(source);
    fs.writeFileSync(destination, bytes, { flag: 'wx', mode: stat.mode & 0o777 });
    budget.copies.push({ relative: path.relative(sourceRoot, source), sha256: hash(bytes) });
  } else throw new Error('Unsupported special file in the current core package');
}
export async function preparePrivateOverlay(ctx) {
  const facts = profileFacts(ctx);
  assertCommunityLiveProfile(facts);
  ensureOwner(facts);
  if (currentPrivateOverlay(ctx)) throw new Error('A private runtime overlay is already installed; revert it before applying a new generation');
  if (!ctx.loader?.entries || !ctx.pluginPackages?.packageOf) throw new Error('The current Loader and pluginPackages service are required');
  const token = randomUUID();
  const runDir = path.join(facts.ownerDir, token);
  const aiBase = path.join(runDir, 'node_modules', '@deepseek-ai');
  fs.mkdirSync(aiBase, { recursive: true, mode: 0o700 });
  const packages = new Map();
  const rows = [];
  const budget = { files: 0, bytes: 0, copies: [] };
  const libs = await profileLibraries(ctx, facts);
  const loadedProfile = libs.boot.loadProfileDirectory('dsh-purge', facts.dir, facts.profile.installAnchor, { userLayer: false });
  // A surface/preset bundle can itself contain patchable prompt text without
  // being a live Loader plugin. Copy only the selected first-party bundles.
  for (const layer of loadedProfile.layers) {
    if (!/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(layer.packageName)) continue;
    const source = physicalDirectory(fs.realpathSync(layer.packageDir));
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    if (manifest.name !== layer.packageName || typeof manifest.version !== 'string') throw new Error('Selected core bundle identity changed');
    const destination = path.join(aiBase, manifest.name.split('/')[1]); budget.copies = [];
    copyPackage(source, destination, budget);
    packages.set(manifest.name, { name: manifest.name, version: manifest.version, sourceDir: source, privateDir: destination, copiedFiles: budget.copies, selectedBundle: true });
  }
  const actualEntries = [...ctx.loader.entries()];
  const all = [...actualEntries];
  // Preset plugins are deferred Loader rows. Their declarations are already
  // owned by this running profile even before a session instantiates the tree.
  // Resolve each row from its declaring Loader's actual base, keeping its own
  // preset-local ID; different presets may intentionally reuse these IDs.
  for (const owner of actualEntries) {
    if (owner.disabled) continue;
    const plugins = owner.options?.config?.plugins;
    if (!Array.isArray(plugins)) continue;
    const visit = (entries, prefix) => {
      for (const [index, options] of entries.entries()) {
        if (!options || typeof options !== 'object') continue;
        const scope = prefix + '/' + index;
        all.push({ options, parent: owner.parent, disabled: options.disabled === true, presetOwnerId: owner.options.id, presetRowPath: scope });
        if (options.group && Array.isArray(options.config)) visit(options.config, scope + '/config');
        if (Array.isArray(options.config?.plugins)) visit(options.config.plugins, scope + '/plugins');
      }
    };
    visit(plugins, owner.options.id + '/plugins');
  }
  for (const entry of all) {
    const name = entry.options?.name;
    if (typeof name !== 'string' || !/^@deepseek-ai\/dsh-[a-z0-9-]+(?:\/|$)/.test(name) || entry.options.group || entry.disabled || entry.options.disabled === true) continue;
    const baseUrl = entry.parent?.tree?.ctx?.baseUrl;
    if (typeof baseUrl !== 'string') throw new Error('Current Loader row has no resolution base');
    const pkg = ctx.pluginPackages.packageOf(name, baseUrl);
    if (!pkg || !/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(pkg.name)) throw new Error('Current core package ownership cannot be verified');
    const source = fs.realpathSync(pkg.dir);
    physicalDirectory(source);
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    if (manifest.name !== pkg.name || typeof manifest.version !== 'string') throw new Error('Current core package manifest identity changed');
    const url = resolvedEntryUrl(ctx, entry, baseUrl);
    const sourceFile = fs.realpathSync(fileURLToPath(url));
    if (!inside(source, sourceFile)) throw new Error('The actual Loader entry resolves outside its core package');
    let item = packages.get(pkg.name);
    if (!item) {
      const destination = path.join(aiBase, pkg.name.split('/')[1]);
      budget.copies = [];
      copyPackage(source, destination, budget);
      item = { name: pkg.name, version: manifest.version, sourceDir: source, privateDir: destination, copiedFiles: budget.copies };
      packages.set(pkg.name, item);
    } else if (item.sourceDir !== source) throw new Error('A core package resolves to multiple physical directories');
    const privateFile = path.join(item.privateDir, path.relative(source, sourceFile));
    regularFile(privateFile);
    const originalId = entry.options.id;
    if (typeof originalId !== 'string' || !originalId) throw new Error('Current core row requires a stable profile/preset ID');
    if (!entry.presetOwnerId && actualEntries.filter(row => row.options.id === originalId).length !== 1) throw new Error('Current non-preset Loader IDs must be unambiguous');
    const parentEntry = entry.parent?.ctx?.fiber?.entry;
    const bootstrapInclude = parentEntry?.options?.id === 'include' && parentEntry?.options?.name === 'cordis:include'
      && !parentEntry?.parent?.tree?.ctx?.fiber?.entry;
    if (parentEntry?.subtree && !bootstrapInclude) throw new Error('Core rows in nested Include trees cannot be patched by the current profile');
    const parentId = bootstrapInclude ? undefined : parentEntry?.options?.id;
    const clone = structuredClone(entry.options);
    clone.id = originalId;
    clone.name = pathToFileURL(privateFile).href;
    rows.push({ originalId, originalName: name, parentId, presetOwnerId: entry.presetOwnerId, presetRowPath: entry.presetRowPath, clone, sourceFile, privateFile });
  }
  if (!rows.length) throw new Error('No current profile core Loader rows were found');
  // JSON flow objects are valid YAML sequence elements and preserve !!js-backed
  // config objects already parsed by Loader without executing their expressions.
  const patchBody = rowPatchBody(rows);
  const state = { owner: OWNER, token, profileDir: facts.dir, profileInstallAnchor: facts.profile.installAnchor, ...libs.helperIdentity, runDir, aiBase, phase: 'prepared', createdAt: new Date().toISOString(), rows, packages: [...packages.values()], patchBody, patchBodySha256: hash(patchBody), copiedBytes: budget.bytes, copiedFiles: budget.files };
  atomic(path.join(runDir, 'state.json'), json(state));
  return { ...state, profile: facts.profile };
}
async function profileLibraries(ctx, facts) {
  const require = createRequire(facts.profile.installAnchor);
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
  const editorRow = ctx.loader?.entries ? [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-config-editor') : undefined;
  const resolverBase = editorRow?.parent?.tree?.ctx?.baseUrl || pathToFileURL(facts.dir + path.sep).href;
  const editor = ctx.pluginPackages?.packageOf('@deepseek-ai/dsh-config-editor', resolverBase);
  let editorManifestPath = editor?.manifestPath; let recorded;
  if (!editorManifestPath) {
    if (ctx.pluginPackages) throw new Error('The native configuration editor must belong to the current runtime resolution');
    const current = path.join(facts.ownerDir, 'current.json'); regularFile(current);
    recorded = validateState(facts, JSON.parse(fs.readFileSync(current, 'utf8')));
    if (recorded.profileInstallAnchor !== facts.profile.installAnchor) throw new Error('Recorded launcher anchor changed; refusing recovery');
    try { editorManifestPath = require.resolve('@deepseek-ai/dsh-config-editor/package.json'); }
    catch { editorManifestPath = recorded.configEditorManifestPath; }
  }
  editorManifestPath = fs.realpathSync(editorManifestPath); regularFile(editorManifestPath);
  const editorManifest = JSON.parse(fs.readFileSync(editorManifestPath, 'utf8'));
  if (editorManifest.name !== '@deepseek-ai/dsh-config-editor' || typeof editorManifest.version !== 'string' || (recorded && (editorManifestPath !== recorded.configEditorManifestPath || editorManifest.version !== recorded.configEditorVersion))) throw new Error('Native configuration editor helper identity changed');
  const editorRequire = createRequire(editorManifestPath);
  const yamlManifestPath = fs.realpathSync(editorRequire.resolve('yaml/package.json')); regularFile(yamlManifestPath);
  const yamlManifest = JSON.parse(fs.readFileSync(yamlManifestPath, 'utf8'));
  const atomicManifestPath = fs.realpathSync(editorRequire.resolve('@deepseek-ai/dsh-atomic-write/package.json')); regularFile(atomicManifestPath);
  const atomicManifest = JSON.parse(fs.readFileSync(atomicManifestPath, 'utf8'));
  if (yamlManifest.name !== 'yaml' || typeof yamlManifest.version !== 'string' || atomicManifest.name !== '@deepseek-ai/dsh-atomic-write' || typeof atomicManifest.version !== 'string') throw new Error('Native YAML/atomic helper package identity changed');
  if (recorded && (recorded.yamlManifestPath !== yamlManifestPath || recorded.yamlVersion !== yamlManifest.version || recorded.atomicManifestPath !== atomicManifestPath || recorded.atomicVersion !== atomicManifest.version)) throw new Error('Recorded native YAML/atomic helper identity changed; refusing recovery');
  const yamlAst = editorRequire('yaml');
  const nativeAtomic = await import(pathToFileURL(editorRequire.resolve('@deepseek-ai/dsh-atomic-write')).href);
  return { boot, yamlAst, withFileLock: nativeAtomic.withFileLock, helperIdentity: { configEditorManifestPath: editorManifestPath, configEditorVersion: editorManifest.version, yamlManifestPath, yamlVersion: yamlManifest.version, atomicManifestPath, atomicVersion: atomicManifest.version } };
}
function assertSuccessfulPatch(report) {
  if (report?.ok === false || (typeof report?.failed === 'number' && report.failed > 0) || (Array.isArray(report?.failed) && report.failed.length) || report?.failed_items?.length || (Array.isArray(report) && report.some(item => item?.status === 'failed' || item?.status === 'error'))) throw new Error('Private core patch reported a failure; no runtime overlay was mounted');
}
function editPatchNames(text, yamlAst, replacements, direction) {
  if (!replacements.length) return { text, changes: [] };
  const document = yamlAst.parseDocument(text || '[]\n', { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  if (document.errors.length) throw document.errors[0];
  if (document.contents === null) return { text, changes: [] };
  if (!yamlAst.isSeq(document.contents)) throw new Error('Current profile patch must be a YAML sequence');
  const edits = []; const changes = [];
  const visit = node => {
    if (yamlAst.isMap(node)) {
      const id = node.get('id'); const nameNode = node.get('name', true);
      const name = node.get('name');
      const match = replacements.find(row => row.originalId === id && name === (direction === 'apply' ? row.originalName : row.privateName));
      if (match && yamlAst.isScalar(nameNode) && Array.isArray(nameNode.range)) {
        const value = direction === 'apply' ? match.privateName : match.originalName;
        edits.push({ start: nameNode.range[0], end: nameNode.range[1], value: JSON.stringify(value) });
        changes.push({ originalId: id, originalName: match.originalName, privateName: match.privateName });
      }
      for (const pair of node.items) visit(pair.value);
    } else if (yamlAst.isSeq(node)) for (const item of node.items) visit(item);
  };
  visit(document.contents);
  let next = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, edit.start) + edit.value + next.slice(edit.end);
  return { text: next, changes };
}
function rewriteBundlePatches(patches, rows) {
  const copied = structuredClone(patches); const found = new Set();
  const visit = value => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== 'object') return;
    const row = rows.find(item => item.originalId === value.id && item.originalName === value.name);
    if (row) { value.name = row.clone.name; found.add(row.originalId); }
    if (value.insert) visit(value.insert);
    if (Array.isArray(value.config)) visit(value.config);
  };
  visit(copied);
  return { patches: copied, found };
}
function insertedRowIdentities(patches) {
  const rows = [];
  const visitRows = entries => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.id === 'string' && typeof entry.name === 'string') rows.push({ id: entry.id, name: entry.name });
      if (entry.group && Array.isArray(entry.config)) visitRows(entry.config);
    }
  };
  for (const patch of patches || []) if (patch && typeof patch === 'object') visitRows(patch.insert);
  return rows;
}
function launcherOwnedDesktopRows(facts, yaml, include) {
  const rows = new Map();
  const launchedDir = process.env.DSH_DESKTOP_PROFILE_DIR;
  if (facts.profile.name !== 'desktop' || typeof launchedDir !== 'string' || !path.isAbsolute(launchedDir) || fs.realpathSync(launchedDir) !== facts.dir) return rows;
  const require = createRequire(facts.profile.installAnchor);
  let entry;
  try { entry = fs.realpathSync(require.resolve('@deepseek-ai/dsh-desktop-host')); }
  catch { return rows; }
  // Resolve launcher ownership through the same published Host package as the
  // current installation anchor; bootstrap is a separate, explicit published entry.
  regularFile(entry);
  const root = path.dirname(path.dirname(entry)); physicalDirectory(root);
  if (entry !== path.join(root, 'lib', 'index.js')) return rows;
  const manifestPath = path.join(root, 'package.json'); regularFile(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== '@deepseek-ai/dsh-desktop-host' || manifest.version !== '0.2.1-alpha.1') return rows;
  if (!process.argv[1] || !path.isAbsolute(process.argv[1])) return rows;
  const launchedEntry = fs.realpathSync(process.argv[1]);
  if (launchedEntry !== entry) {
    const bootstrap = path.join(root, 'lib', 'bootstrap.js');
    if (!Array.isArray(manifest.files) || !manifest.files.includes('lib/bootstrap.js')
      || launchedEntry !== bootstrap || fs.realpathSync(bootstrap) !== bootstrap) return rows;
    regularFile(bootstrap);
  }
  const actualOverlays = insertedRowIdentities(facts.profile.overlays || []);
  for (const [filename, kind] of [['desktop-defaults.patch.yml', 'launcher-defaults'], ['desktop.cordis.patch.yml', 'launcher-overlay'], ['desktop-presets.patch.yml', 'launcher-overlay']]) {
    const file = path.join(root, 'config', filename); regularFile(file);
    const selected = kind === 'launcher-defaults'
      ? facts.profile.defaultsFiles?.some(value => typeof value === 'string' && path.isAbsolute(value) && fs.realpathSync(value) === file)
      : true;
    if (!selected) continue;
    const bytes = fs.readFileSync(file);
    const declared = insertedRowIdentities(yaml.load(bytes.toString('utf8'), { schema: include.entryListSchema }));
    for (const row of declared) {
      if (kind === 'launcher-overlay' && !actualOverlays.some(item => item.id === row.id && item.name === row.name)) continue;
      const key = row.id + '\0' + row.name;
      if (rows.has(key)) throw new Error('Desktop launcher row provenance is ambiguous: ' + row.id);
      rows.set(key, { kind, source: '@deepseek-ai/dsh-desktop-host/config/' + filename, sourceSha256: hash(bytes) });
    }
  }
  return rows;
}
export async function installPrivateOverlay(ctx, prepared) {
  const facts = profileFacts(ctx);
  assertCommunityLiveProfile(facts);
  const state = validateState(facts, prepared);
  const changedPackages = state.packages.filter(pkg => pkg.copiedFiles.some(file => {
    const privatePath = path.join(pkg.privateDir, file.relative);
    regularFile(privatePath);
    return hash(fs.readFileSync(privatePath)) !== file.sha256;
  }));
  state.rows = state.rows.filter(row => changedPackages.some(pkg => inside(pkg.privateDir, row.privateFile)));
  if (!changedPackages.length) throw new Error('No current core package bytes changed; no runtime overlay was installed');
  state.mountedPackages = changedPackages.map(pkg => pkg.name);
  const libs = await profileLibraries(ctx, facts);
  return libs.withFileLock(path.join(facts.dir, 'package.json'), async () => {
    const manifestPath = path.join(facts.dir, 'package.json'); regularFile(manifestPath);
    const beforeManifest = fs.readFileSync(manifestPath, 'utf8'); const manifest = JSON.parse(beforeManifest);
    const bundles = manifest.dsh?.profile?.bundles;
    if (!Array.isArray(bundles)) throw new Error('Current profile bundle list is invalid');
    const loaded = libs.boot.loadProfileDirectory('dsh-purge', facts.dir, facts.profile.installAnchor);
    const yaml = createRequire(facts.profile.installAnchor)('js-yaml');
    const include = await import(pathToFileURL(createRequire(facts.profile.installAnchor).resolve('@deepseek-ai/cordis-plugin-include')).href);
    const found = new Set(); const replacements = [];
    let patchNames = state.rows.map(row => ({ originalId: row.originalId, originalName: row.originalName, privateName: row.clone.name }));
    const modules = path.join(facts.dir, 'node_modules');
    if (!fs.existsSync(modules)) fs.mkdirSync(modules, { mode: 0o700 }); physicalDirectory(modules);
    for (const [index, layer] of loaded.layers.entries()) {
      const packageRoot = fs.realpathSync(layer.packageDir);
      const privateBundle = state.packages.find(pkg => pkg.name === layer.packageName && pkg.sourceDir === packageRoot);
      const patchEdits = layer.patchPaths.map(file => {
        const originalPath = fs.realpathSync(file);
        if (!inside(packageRoot, originalPath)) throw new Error('Bundle patch file is outside its package');
        const originalText = fs.readFileSync(originalPath, 'utf8');
        const relative = path.relative(packageRoot, originalPath);
        const privatePatch = privateBundle ? path.join(privateBundle.privateDir, relative) : undefined;
        if (privatePatch) regularFile(privatePatch);
        const sourceText = privatePatch ? fs.readFileSync(privatePatch, 'utf8') : originalText;
        const edited = editPatchNames(sourceText, libs.yamlAst, patchNames, 'apply');
        return { relative, originalText, privateCoreChanged: sourceText !== originalText, ...edited };
      });
      if (!patchEdits.some(edit => edit.changes.length || edit.privateCoreChanged)) continue;
      const alias = 'dsh-purge-private-' + state.token + '-bundle-' + index;
      const aliasDir = path.join(modules, alias);
      const aliasSource = path.join(state.runDir, 'bundles', alias);
      if (fs.existsSync(aliasDir) || fs.existsSync(aliasSource) || Object.hasOwn(manifest.dependencies || {}, alias)) throw new Error('Owned bundle alias already exists');
      copyPackage(privateBundle?.privateDir || packageRoot, aliasSource, { bytes: 0, files: 0, copies: [] });
      const aliasManifestPath = path.join(aliasSource, 'package.json');
      const originalManifest = JSON.parse(fs.readFileSync(aliasManifestPath, 'utf8'));
      fs.writeFileSync(path.join(aliasSource, 'ORIGINAL-PACKAGE.json'), json(originalManifest), { flag: 'wx', mode: 0o600 });
      const aliasManifest = { name: alias, version: originalManifest.version || '0.0.0', private: true, type: 'module', license: originalManifest.license, dsh: { bundle: originalManifest.dsh.bundle }, deepseekStreamPrivateRuntime: { owner: OWNER, token: state.token, originalPackage: layer.packageName } };
      atomic(aliasManifestPath, json(aliasManifest));
      for (const edit of patchEdits) if (edit.changes.length || edit.privateCoreChanged) atomic(path.join(aliasSource, edit.relative), edit.text);
      copyPackage(aliasSource, aliasDir, { bytes: 0, files: 0, copies: [] });
      const positions = bundles.map((name, slot) => name === layer.packageName ? slot : -1).filter(slot => slot >= 0);
      if (positions.length !== 1) throw new Error('Source bundle selection must be unambiguous');
      const dependency = 'file:' + path.relative(facts.dir, aliasSource).split(path.sep).join('/');
      replacements.push({ original: layer.packageName, alias, aliasDir, aliasSource, aliasVersion: aliasManifest.version, dependency, originalSlot: positions[0] });
      for (const edit of patchEdits) for (const change of edit.changes) found.add(change.originalId);
    }
    const previous = readPatch(facts);
    let changedPatch = editPatchNames(previous, libs.yamlAst, patchNames, 'apply');
    const directPatches = yaml.load(changedPatch.text || '[]\n', { schema: include.entryListSchema });
    const launcherRows = launcherOwnedDesktopRows(facts, yaml, include);
    const unsupportedRows = [];
    for (const row of state.rows) if (!found.has(row.originalId)) {
      let inserted = false;
      const walk = value => { if (Array.isArray(value)) { for (const item of value) walk(item); } else if (value && typeof value === 'object') { if (value.id === row.originalId && value.name === row.clone.name && !value.insert) inserted = true; if (value.insert) walk(value.insert); if (Array.isArray(value.config)) walk(value.config); } };
      for (const patch of directPatches || []) if (patch.insert) walk(patch.insert);
      if (!inserted) {
        const provenance = launcherRows.get(row.originalId + '\0' + row.originalName);
        if (!provenance) throw new Error('Changed core row is not owned by a current profile bundle or user insertion: ' + row.originalId);
        unsupportedRows.push({ rowId: row.originalId, moduleName: row.originalName, ...provenance, reason: 'The immutable Desktop launcher owns this row; its original module and configuration are preserved instead of mounting a private replacement.' });
      }
    }
    state.rows = state.rows.filter(row => !unsupportedRows.some(item => item.rowId === row.originalId && item.moduleName === row.originalName));
    if (!state.rows.length) throw new Error('No changed core rows can be mounted from the current profile bundles or user insertions');
    patchNames = state.rows.map(row => ({ originalId: row.originalId, originalName: row.originalName, privateName: row.clone.name }));
    changedPatch = editPatchNames(previous, libs.yamlAst, patchNames, 'apply');
    if (!replacements.length && changedPatch.text === previous) throw new Error('No changed private core bundle or user insertion can be mounted');
    state.unsupportedRows = unsupportedRows;
    state.mountedPackages = changedPackages.filter(pkg => state.rows.some(row => inside(pkg.privateDir, row.privateFile)) || replacements.some(item => item.original === pkg.name)).map(pkg => pkg.name);
    state.overlayKind = 'bundle-alias'; state.bundleReplacements = replacements; state.patchNameChanges = changedPatch.changes; state.patchNameMappings = patchNames; state.originalDependenciesExisted = Object.hasOwn(manifest, 'dependencies');
    state.phase = 'prepared'; state.originalManifestSha256 = hash(beforeManifest); state.originalPatchSha256 = hash(previous); delete state.profile;
    atomic(path.join(facts.ownerDir, 'current.json'), json(state));
    for (const replacement of replacements) { bundles[replacement.originalSlot] = replacement.alias; (manifest.dependencies ||= {})[replacement.alias] = replacement.dependency; }
    if (fs.readFileSync(manifestPath, 'utf8') !== beforeManifest || readPatch(facts) !== previous) throw new Error('Profile changed while preparing its private bundles');
    if (changedPatch.text !== previous) atomic(facts.patchPath, changedPatch.text);
    try { atomic(manifestPath, json(manifest)); } catch (error) { if (readPatch(facts) === changedPatch.text && changedPatch.text !== previous) atomic(facts.patchPath, previous); throw error; }
    state.phase = 'installed'; atomic(path.join(facts.ownerDir, 'current.json'), json(state)); atomic(path.join(state.runDir, 'state.json'), json(state));
    return { ...state, restartRequired: true, privateRows: state.rows.length, profile: facts.profile };
  });
}
export async function applyPrivateOverlay(ctx, { patch } = {}) {
  const facts = profileFacts(ctx);
  assertCommunityLiveProfile(facts);
  return withLock(facts, ctx, async () => {
    if (typeof patch !== 'function') throw new Error('An explicit private-core patch callback is required');
    const active = currentPrivateOverlay(ctx);
    if (active) {
      if (active.requiresRestore || active.phase === 'partial') throw new Error('A previous private overlay commit was interrupted. Restore it before applying again; no Apply success was reported.');
      const report = await patch(active.aiBase, active);
      assertSuccessfulPatch(report);
      return { ...active, report: { ...report, unsupportedRows: active.unsupportedRows || [] }, restartRequired: true, privateRows: active.rows.length, reused: true };
    }
    const prepared = await preparePrivateOverlay(ctx);
    const report = await patch(prepared.aiBase, prepared);
    assertSuccessfulPatch(report);
    const installed = await installPrivateOverlay(ctx, prepared);
    return { ...installed, report: { ...report, unsupportedRows: installed.unsupportedRows || [] } };
  });
}
export async function restorePrivateOverlay(ctx, { revert } = {}) {
  const facts = profileFacts(ctx);
  assertCommunityLiveProfile(facts);
  return withLock(facts, ctx, async () => {
    const state = currentPrivateOverlay(ctx);
    if (!state) return { restored: false, restartRequired: false };
    const libs = await profileLibraries(ctx, facts);
    return libs.withFileLock(path.join(facts.dir, 'package.json'), async () => {
      const manifestPath = path.join(facts.dir, 'package.json'); regularFile(manifestPath);
      const beforeManifest = fs.readFileSync(manifestPath, 'utf8'); const manifest = JSON.parse(beforeManifest);
      const bundles = manifest.dsh?.profile?.bundles;
      if (!Array.isArray(bundles)) throw new Error('Current profile bundle list is invalid');
      const previous = readPatch(facts);
      // A ConfigEditor write can change formatting and comments. Restore only
      // fields still carrying our private URL, never a subsequently edited value.
      const restoredPatch = editPatchNames(previous, libs.yamlAst, state.patchNameMappings || state.patchNameChanges || [], 'revert');
      for (const replacement of state.bundleReplacements) {
        const slots = bundles.map((name, slot) => name === replacement.alias ? slot : -1).filter(slot => slot >= 0);
        if (slots.length > 1) throw new Error('Owned bundle alias is selected more than once; resolve it before reverting');
        if (slots.length === 1) bundles[slots[0]] = replacement.original;
        if (manifest.dependencies?.[replacement.alias] === replacement.dependency) delete manifest.dependencies[replacement.alias];
      }
      if (state.originalDependenciesExisted === false && manifest.dependencies && !Object.keys(manifest.dependencies).length) delete manifest.dependencies;
      const report = typeof revert === 'function' ? await revert(state.aiBase, state) : undefined;
      if (readPatch(facts) !== previous || fs.readFileSync(manifestPath, 'utf8') !== beforeManifest) throw new Error('Profile changed while reverting; no user patch was overwritten');
      if (restoredPatch.text !== previous) atomic(facts.patchPath, restoredPatch.text);
      try { atomic(manifestPath, json(manifest)); } catch (error) { if (readPatch(facts) === restoredPatch.text && restoredPatch.text !== previous) atomic(facts.patchPath, previous); throw error; }
      state.phase = 'reverted'; state.revertedAt = new Date().toISOString(); delete state.profile;
      atomic(path.join(facts.ownerDir, 'current.json'), json(state)); atomic(path.join(state.runDir, 'state.json'), json(state));
      // Keep aliases, private copies and audit metadata; never delete user edits.
      return { restored: true, restartRequired: true, report, retainedCopy: state.runDir };
    });
  });
}
