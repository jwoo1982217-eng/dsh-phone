import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rebasePrivateBundleRecipes, rewriteProfileBuiltinNames } from './private-bundle-recipes.js';

const privateModulesRoot = '/private-owned/node_modules';
const resolvePrivateModule = name => pathToFileURL(path.join(privateModulesRoot, name, 'lib/index.js')).href;
const codecs = { parse: JSON.parse, dump: value => JSON.stringify(value, null, 2) + '\n' };
const doc = value => JSON.stringify(value);
const row = (id, name, config) => ({ id, name, ...(config ? { config } : {}) });

function baseFixture() {
  const old = [{ insert: [row('approval', '@deepseek-ai/dsh-user-approval', { policy: { __jsExpr: 'oldPolicy' } }), row('sandbox-policy', '@deepseek-ai/dsh-sandbox-policy', { mode: { __jsExpr: 'oldMode' }, workspaceRoot: '/retained' }), row('timer', '@deepseek-ai/cordis-plugin-timer')] }];
  const current = structuredClone(old);
  current[0].insert[0].config.policy = { __jsExpr: 'retainedPolicy' };
  current[0].insert[0].name = resolvePrivateModule(current[0].insert[0].name);
  const next = structuredClone(old);
  next[0].insert.unshift(row('remote-access', '@deepseek-ai/dsh-api-remote-access'));
  next[0].insert[2].config.newReleaseField = true;
  return { originalPackage: '@deepseek-ai/dsh-base', oldFiles: { 'cordis.patch.yml': doc(old) }, currentFiles: { 'cordis.patch.yml': doc(current) }, newFiles: { 'cordis.patch.yml': doc(next) }, patchNameMappings: [{ originalId: 'approval', originalName: '@deepseek-ai/dsh-user-approval', privateName: resolvePrivateModule('@deepseek-ai/dsh-user-approval') }], privateModulesRoot, resolvePrivateModule, ...codecs };
}

test('known private values transfer by identity while new providers/default fields survive', () => {
  const f = baseFixture(), before = { oldFiles: structuredClone(f.oldFiles), currentFiles: structuredClone(f.currentFiles), newFiles: structuredClone(f.newFiles) };
  const result = rebasePrivateBundleRecipes(f);
  const rows = JSON.parse(result.files['cordis.patch.yml'])[0].insert;
  assert.equal(rows[0].name, resolvePrivateModule('@deepseek-ai/dsh-api-remote-access'));
  assert.deepEqual(rows.find(x => x.id === 'approval').config.policy, { __jsExpr: 'retainedPolicy' });
  assert.equal(rows.find(x => x.id === 'sandbox-policy').config.newReleaseField, true);
  assert.equal(rows.find(x => x.id === 'timer').name, resolvePrivateModule('@deepseek-ai/cordis-plugin-timer'));
  assert.equal(result.transfers.length, 1);
  assert.equal(result.routes.length, 4);
  assert.deepEqual(f.oldFiles, before.oldFiles);
  assert.deepEqual(f.currentFiles, before.currentFiles);
  assert.deepEqual(f.newFiles, before.newFiles);
});

test('unknown configuration changes fail before returning any converted recipe', () => {
  const f = baseFixture(), current = JSON.parse(f.currentFiles['cordis.patch.yml']);
  current[0].insert[1].config.workspaceRoot = '/unknown';
  f.currentFiles['cordis.patch.yml'] = doc(current);
  assert.throws(() => rebasePrivateBundleRecipes(f), /Unrecognized private recipe edit/);
});

test('a caller-bound actual-file digest rejects even edits inside an allowed field; original retry succeeds', () => {
  const f = baseFixture(), original = f.currentFiles['cordis.patch.yml'];
  f.expectedCurrentSha256 = { 'cordis.patch.yml': createHash('sha256').update(original).digest('hex') };
  const changed = JSON.parse(original); changed[0].insert[0].config.policy.__jsExpr = 'unreviewedLaterEdit';
  f.currentFiles['cordis.patch.yml'] = doc(changed);
  assert.throws(() => rebasePrivateBundleRecipes(f), /checksum/);
  f.currentFiles['cordis.patch.yml'] = original;
  assert.equal(rebasePrivateBundleRecipes(f).transfers.length, 1);
});

test('prototype-path edits cannot mutate the process even inside an admitted field', () => {
  const f = baseFixture(), current = JSON.parse(f.currentFiles['cordis.patch.yml']);
  current[0].insert[0].config.policy = JSON.parse('{"__proto__":{"recipePollution":true}}');
  f.currentFiles['cordis.patch.yml'] = doc(current);
  assert.throws(() => rebasePrivateBundleRecipes(f), /field path/);
  assert.equal({}.recipePollution, undefined);
});

test('unknown row deletion, reorder, duplicate identity, and injected entry all fail closed', () => {
  for (const mutate of [x => x[0].insert.pop(), x => x[0].insert.reverse(), x => x[0].insert.push(structuredClone(x[0].insert[0])), x => x[0].insert.push(row('new', 'user-extra'))]) {
    const f = baseFixture(), current = JSON.parse(f.currentFiles['cordis.patch.yml']);
    mutate(current); f.currentFiles['cordis.patch.yml'] = doc(current);
    assert.throws(() => rebasePrivateBundleRecipes(f), /Unrecognized|Duplicate/);
  }
});

test('a private URL not bound by the owner mappings is never adopted', () => {
  const f = baseFixture(), current = JSON.parse(f.currentFiles['cordis.patch.yml']);
  current[0].insert[1].name = 'file:///unowned/entry.js';
  f.currentFiles['cordis.patch.yml'] = doc(current);
  assert.throws(() => rebasePrivateBundleRecipes(f), /Unrecognized/);
});

test('private module resolution must stay inside the owned closure and retain old file URLs', () => {
  const f = baseFixture();
  assert.throws(() => rebasePrivateBundleRecipes({ ...f, resolvePrivateModule: () => 'file:///other/entry.js' }), /outside|closure/);
  assert.throws(() => rebasePrivateBundleRecipes({ ...f, resolvePrivateModule: name => pathToFileURL(path.join(privateModulesRoot, name, 'new.js')).href }), /Registered private plugin URL changed/);
});

function presetFixture() {
  const persona = id => row('persona', '@deepseek-ai/dsh-persona', { prefix: id });
  const preset = (id, prefix) => row(id, '@deepseek-ai/dsh-agent-preset', { id: id.slice(7), plugins: [persona(prefix), { id: 'persistent-shell', name: 'cordis:group', group: true, isolate: { terminal: true }, config: [row('pty', '@deepseek-ai/dsh-terminal')] }] });
  const old = [{ insert: [preset('preset-standard', 'standard-original'), preset('preset-minimal', 'minimal-original')] }];
  const current = structuredClone(old);
  current[0].insert[0].config.plugins[0].config.prefix = 'standard-private';
  current[0].insert[1].config.plugins[0].config.prefix = 'minimal-private';
  current[0].insert[1].config.plugins.splice(1, 0, row('agent-instructions', '@deepseek-ai/dsh-agent-instructions', { maxBytes: 65536 }));
  const next = structuredClone(old);
  next[0].insert[1].config.plugins.splice(1, 0, row('tool-fs', '@deepseek-ai/dsh-tool-fs', { read: true }));
  return { originalPackage: '@deepseek-ai/dsh-web-app', oldFiles: { 'presets/minimal.patch.yml': doc(old) }, currentFiles: { 'presets/minimal.patch.yml': doc(current) }, newFiles: { 'presets/minimal.patch.yml': doc(next) }, patchNameMappings: [], privateModulesRoot, resolvePrivateModule, ...codecs };
}

test('preset-local duplicate IDs remain separate and a reviewed instruction row preserves new minimal tools', () => {
  const f = presetFixture(), result = rebasePrivateBundleRecipes(f);
  const presets = JSON.parse(result.files['presets/minimal.patch.yml'])[0].insert;
  assert.equal(presets[0].config.plugins[0].config.prefix, 'standard-private');
  assert.equal(presets[1].config.plugins[0].config.prefix, 'minimal-private');
  assert.deepEqual(presets[1].config.plugins.map(x => x.id), ['persona', 'agent-instructions', 'tool-fs', 'persistent-shell']);
  assert.equal(presets[1].config.plugins.at(-1).config[0].id, 'pty');
  assert.equal(result.addedRows.length, 1);
});

test('a renamed or removed new-release destination refuses rather than losing a private value', () => {
  const f = baseFixture(), next = JSON.parse(f.newFiles['cordis.patch.yml']);
  next[0].insert.find(x => x.id === 'approval').id = 'approval-renamed'; f.newFiles['cordis.patch.yml'] = doc(next);
  assert.throws(() => rebasePrivateBundleRecipes(f), /destination|target/);
});

test('new-release file omissions and invalid codec input refuse without changing inputs', () => {
  const f = baseFixture();
  assert.throws(() => rebasePrivateBundleRecipes({ ...f, newFiles: {} }), /recipe file/);
  assert.throws(() => rebasePrivateBundleRecipes({ ...f, currentFiles: { 'cordis.patch.yml': '{}' } }), /sequence/);
});

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const work = process.env.DSH_PRIVATE_RECIPE_FIXTURE ?? path.join(os.homedir(), '.codex/work/dsh-mobile-feature-completion-20261020');
const actual = path.join(work, 'deployment/actual-profile-aliases');
const actualAvailable = fs.existsSync(path.join(actual, 'profile-cordis.patch.yml.private')) && fs.existsSync(path.join(work, 'runtime-node_modules-alpha1-before/@deepseek-ai/dsh-base/package.json'));

test('profile rewrites visit plugin lists only, retaining lookalike configuration objects and JS tags', () => {
  const require = createRequire(path.join(repo, 'runtime/package.json')), yamlAst = require('yaml');
  const text = `# retain this comment\n- id: approval\n  name: '@deepseek-ai/dsh-user-approval' # comment\n  config:\n    policy: !!js ctx.get('customPolicy')\n    nested: {id: approval, name: '@deepseek-ai/dsh-user-approval'}\n- insert:\n  - id: preset-standard\n    name: '@deepseek-ai/dsh-agent-preset'\n    config:\n      plugins:\n      - id: persona\n        name: '@deepseek-ai/dsh-persona'\n        config: {prefix: 'Keep exactly this text.'}\n- id: outside\n  name: 'file:///outside/custom.mjs'\n`;
  const result = rewriteProfileBuiltinNames(text, { yamlAst, privateModulesRoot, resolvePrivateModule });
  assert.equal(result.edits.length, 3);
  assert.ok(result.text.includes("nested: {id: approval, name: '@deepseek-ai/dsh-user-approval'}"));
  assert.ok(result.text.includes("policy: !!js ctx.get('customPolicy')"));
  assert.ok(result.text.includes("name: 'file:///outside/custom.mjs'"));
  assert.ok(result.text.includes("config: {prefix: 'Keep exactly this text.'}"));
  assert.ok(result.text.includes('# comment'));
});

test('profile names using aliases/expressions and an escaping resolver refuse before an output is returned', () => {
  const require = createRequire(path.join(repo, 'runtime/package.json')), yamlAst = require('yaml');
  const options = { yamlAst, privateModulesRoot, resolvePrivateModule };
  assert.throws(() => rewriteProfileBuiltinNames("- &first {id: one, name: &name '@deepseek-ai/dsh-session'}\n- {id: two, name: *name}\n", options), /literal string/);
  assert.throws(() => rewriteProfileBuiltinNames('- id: one\n  name: !!js expression\n', options), /literal string/);
  assert.throws(() => rewriteProfileBuiltinNames('- {id: one, name: "@deepseek-ai/dsh-session"}\n', { ...options, resolvePrivateModule: () => 'file:///outside/core.js' }), /outside owned closure/);
  assert.deepEqual(rewriteProfileBuiltinNames('# only a comment\n', options), { text: '# only a comment\n', edits: [], routes: [] });
});

async function actualFixture() {
  const require = createRequire(path.join(repo, 'runtime/package.json'));
  const yaml = require('js-yaml'), yamlAst = require('yaml');
  const include = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')));
  const current = JSON.parse(fs.readFileSync(path.join(work, 'phone-readonly/current.private.json'), 'utf8'));
  const modulesRoot = path.join(current.runDir, 'node_modules');
  const deployedModules = path.join(work, 'full-private-sdk-actual-acceptance/home/profiles/phone/.dsh-purge-runtime', current.token, 'node_modules');
  const privateRequire = createRequire(path.join(deployedModules, '@deepseek-ai/dsh/package.json'));
  const resolve = name => {
    const relative = path.relative(deployedModules, privateRequire.resolve(name));
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('Fixture dependency escaped private closure');
    return pathToFileURL(path.join(modulesRoot, relative)).href;
  };
  const parse = text => yaml.load(text, { schema: include.entryListSchema });
  const dump = value => yaml.dump(value, { schema: include.entryListSchema, noRefs: true, lineWidth: -1 });
  return { current, modulesRoot, resolve, parse, dump, yamlAst };
}

test('actual two private aliases retain all reviewed deltas/scopes with complete rc2 recipes', { skip: !actualAvailable }, async () => {
  const f = await actualFixture(); let transfers = 0, added = 0; const retained = new Set(), allRoutes = [];
  for (const item of f.current.bundleReplacements) {
    const beforeRoot = path.join(work, 'runtime-node_modules-alpha1-before', item.original);
    const currentRoot = path.join(actual, item.alias), newRoot = path.join(repo, 'runtime/node_modules', item.original);
    const oldManifest = JSON.parse(fs.readFileSync(path.join(beforeRoot, 'package.json'))), nextManifest = JSON.parse(fs.readFileSync(path.join(newRoot, 'package.json')));
    const filesOf = (root, manifest) => Object.fromEntries([manifest.dsh.bundle.patch].flat().map(name => [name.replace(/^\.\//, ''), fs.readFileSync(path.join(root, name), 'utf8')]));
    const input = { originalPackage: item.original, oldFiles: filesOf(beforeRoot, oldManifest), currentFiles: filesOf(currentRoot, oldManifest), newFiles: filesOf(newRoot, nextManifest), patchNameMappings: f.current.patchNameMappings, privateModulesRoot: f.modulesRoot, resolvePrivateModule: f.resolve, parse: f.parse, dump: f.dump };
    const result = rebasePrivateBundleRecipes(input);
    allRoutes.push(...result.routes);
    transfers += result.transfers.length; added += result.addedRows.length;
    for (const route of result.routes) if (f.current.patchNameMappings.some(x => x.privateName === route.privateName)) retained.add(route.privateName);
    if (item.original.endsWith('dsh-web-app')) {
      assert.equal(Object.keys(result.files).length, 5);
      assert.equal(result.files['cordis.patch.yml'].includes('webRuntime'), false);
      assert.ok(result.routes.some(x => x.originalName === '@deepseek-ai/dsh-agent-preset-registry'));
      const minimal = f.parse(result.files['presets/minimal.patch.yml'])[0].insert[0].config.plugins;
      assert.ok(minimal.some(x => x.id === 'tool-fs'));
      assert.ok(minimal.some(x => x.id === 'compaction'));
      assert.ok(minimal.some(x => x.id === 'agent-instructions'));
    } else {
      assert.ok(result.routes.some(x => x.originalName === '@deepseek-ai/dsh-api-remote-access'));
      assert.ok(result.routes.some(x => x.originalName === '@deepseek-ai/dsh-working-directory'));
    }
    const unknown = { ...input, currentFiles: structuredClone(input.currentFiles) }, file = Object.keys(unknown.currentFiles)[0];
    const rows = f.parse(unknown.currentFiles[file]); rows.push({ id: 'unreviewed-row', name: 'user-added-code' }); unknown.currentFiles[file] = f.dump(rows);
    assert.throws(() => rebasePrivateBundleRecipes(unknown), /Unrecognized/);
  }
  assert.equal(transfers, 14); assert.equal(added, 1);
  assert.equal(retained.size, new Set(f.current.patchNameMappings.map(x => x.privateName)).size);
  for (const original of f.current.rows) assert.ok(allRoutes.some(route => route.originalId === original.originalId
    && route.originalName === original.originalName && route.privateName === original.clone.name
    && (original.presetOwnerId ? route.key.startsWith('root/entry:' + original.presetOwnerId + '/plugins/') : !route.key.includes('/plugins/'))), 'Missing original scoped private row: ' + original.originalId);
});

test('actual user profile only changes name token ranges, retaining config bytes and external code', { skip: !actualAvailable }, async () => {
  const f = await actualFixture();
  const text = fs.readFileSync(path.join(actual, 'profile-cordis.patch.yml.private'), 'utf8');
  const result = rewriteProfileBuiltinNames(text, { yamlAst: f.yamlAst, resolvePrivateModule: f.resolve, privateModulesRoot: f.modulesRoot, patchNameMappings: f.current.patchNameMappings });
  assert.equal(result.routes.length, 6);
  const reverse = [...result.edits].sort((a, b) => b.afterStart - a.afterStart).reduce((s, edit) => s.slice(0, edit.afterStart) + edit.before + s.slice(edit.afterEnd), result.text);
  assert.equal(reverse, text);
  const beforeRows = f.parse(text), afterRows = f.parse(result.text);
  const entries = rows => rows.flatMap(x => [x, ...entries(x.insert ?? []), ...entries(Array.isArray(x.config?.plugins) ? x.config.plugins : []), ...entries(x.group === true && Array.isArray(x.config) ? x.config : [])]);
  assert.equal(entries(afterRows).find(x => x.id === 'security-apk-local-adaptation').name, entries(beforeRows).find(x => x.id === 'security-apk-local-adaptation').name);
  assert.ok(result.text.includes('@zseven-w/dsh-noema'));
  const repeat = rewriteProfileBuiltinNames(result.text, { yamlAst: f.yamlAst, resolvePrivateModule: f.resolve, privateModulesRoot: f.modulesRoot, patchNameMappings: f.current.patchNameMappings });
  assert.equal(repeat.text, result.text); assert.equal(repeat.edits.length, 0);
});

test('a custom plugin config.plugins list is ordinary data, not a preset to rewrite', () => {
  const require = createRequire(path.join(repo, 'runtime/package.json')), yamlAst = require('yaml');
  const text = `- id: custom\n  name: user-custom-plugin\n  config:\n    plugins:\n    - id: sample\n      name: '@deepseek-ai/dsh-session'\n      config: {description: sample-data}\n`;
  const result = rewriteProfileBuiltinNames(text, { yamlAst, privateModulesRoot, resolvePrivateModule });
  assert.equal(result.text, text);
  assert.equal(result.edits.length, 0);
});

test('a known private agent-preset keeps nested plugin rewriting on repeated traversal', () => {
  const require = createRequire(path.join(repo, 'runtime/package.json')), yamlAst = require('yaml');
  const text = `- id: preset-standard\n  name: '${resolvePrivateModule('@deepseek-ai/dsh-agent-preset')}'\n  config:\n    plugins:\n    - id: persona\n      name: '@deepseek-ai/dsh-persona'\n      config: {prefix: 'Retain.'}\n`;
  const result = rewriteProfileBuiltinNames(text, { yamlAst, privateModulesRoot, resolvePrivateModule });
  assert.equal(result.edits.length, 1);
  assert.equal(result.routes[0].originalName, '@deepseek-ai/dsh-persona');
  assert.ok(result.text.includes("config: {prefix: 'Retain.'}"));
});
