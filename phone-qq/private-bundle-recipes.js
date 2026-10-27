import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const hash = value => createHash('sha256').update(value).digest('hex');
const builtin = name => typeof name === 'string' && /^@deepseek-ai\/(?:dsh(?:-|$)|cordis(?:-|$))/.test(name);
const packages = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
const presets = new Set(['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis']);
const own = (value, key) => Object.hasOwn(value, key);
const clone = value => structuredClone(value);
const fail = detail => { throw Error('Unrecognized private recipe edit: ' + detail); };

function safeFilename(file) {
  if (typeof file !== 'string' || !file || file.startsWith('/') || file.includes('\\') || file.split('/').some(x => !x || x === '.' || x === '..')) throw Error('Invalid private recipe filename');
  return file;
}

function readRecipe(text, parse) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024) throw Error('Invalid private recipe file');
  const value = parse(text);
  if (!Array.isArray(value)) throw Error('Private recipe must be a sequence');
  return value;
}

function mappingTable(rows) {
  if (!Array.isArray(rows)) throw Error('Private plugin mappings must be an array');
  const table = new Map();
  for (const row of rows) {
    if (typeof row?.originalId !== 'string' || typeof row.originalName !== 'string' || typeof row.privateName !== 'string') throw Error('Invalid private plugin mapping');
    const key = row.originalId + '\0' + row.privateName;
    const previous = table.get(key);
    if (previous && previous.originalName !== row.originalName) throw Error('Ambiguous private plugin mapping');
    table.set(key, row);
  }
  return table;
}

/** Index row identity inside its preset/group, never by a process-global id. */
function indexRecipe(document, table = new Map()) {
  const refs = new Map();
  const presetRow = row => row.name === '@deepseek-ai/dsh-agent-preset'
    || table.get(row.id + '\0' + row.name)?.originalName === '@deepseek-ai/dsh-agent-preset';
  const add = (key, row, list, index, scope) => {
    if (refs.has(key)) throw Error('Duplicate private recipe identity: ' + key);
    const ref = { key, row, list, index, scope };
    refs.set(key, ref);
    return ref;
  };
  function entries(list, scope) {
    if (!Array.isArray(list)) fail('plugin list shape');
    for (const [index, row] of list.entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id) fail('entry without stable identity');
      const key = scope + '/entry:' + row.id;
      add(key, row, list, index, scope);
      if (row.group === true) entries(row.config, key + '/config');
      if (presetRow(row) && Array.isArray(row.config?.plugins)) entries(row.config.plugins, key + '/plugins');
      if (row.insert !== undefined) entries(row.insert, key + '/insert');
    }
  }
  for (const [index, row] of document.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('patch shape');
    if (typeof row.id === 'string') {
      const key = 'patch:' + row.id;
      add(key, row, document, index, 'patch');
      if (presetRow(row) && Array.isArray(row.config?.plugins)) entries(row.config.plugins, key + '/plugins');
      if (row.group === true) entries(row.config, key + '/config');
      if (row.insert !== undefined) entries(row.insert, key + '/insert');
    } else if (row.insert !== undefined) {
      if (Object.keys(row).some(k => k !== 'insert')) fail('anonymous patch properties');
      entries(row.insert, 'root');
    } else fail('anonymous patch without insertion');
  }
  return refs;
}

function normalizeNames(document, table) {
  for (const { row } of indexRecipe(document, table).values()) {
    if (typeof row.name !== 'string') continue;
    const mapping = table.get(row.id + '\0' + row.name);
    if (mapping) row.name = mapping.originalName;
  }
  return document;
}

function ownRow(row) {
  const result = clone(row);
  delete result.insert;
  if (row.group === true && Array.isArray(row.config)) result.config = { __recipeChildList: 'group' };
  else if (row.name === '@deepseek-ai/dsh-agent-preset' && Array.isArray(row.config?.plugins)) result.config.plugins = { __recipeChildList: 'preset' };
  return result;
}

function leafChanges(before, after, at = []) {
  if (isDeepStrictEqual(before, after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => leafChanges(before[key], after[key], [...at, key]));
  }
  return [{ at, before, after }];
}

function allowedTransfer(originalPackage, file, key, at) {
  if (at[0] !== 'config' || typeof at[1] !== 'string') return false;
  if (originalPackage === '@deepseek-ai/dsh-base' && file === 'cordis.patch.yml') {
    const allowed = { 'root/entry:sandbox-policy': 'mode', 'root/entry:bash-sandbox': 'timeoutMs', 'root/entry:approval': 'policy', 'root/entry:plan-mode': 'section' };
    return allowed[key] === at[1];
  }
  if (originalPackage !== '@deepseek-ai/dsh-web-app') return false;
  if (file === 'cordis.patch.yml') return key === 'patch:system-prompt' && at[1] === 'personaPrefix';
  if (!/^presets\/(?:standard|ptc|minimal|cordis)\.patch\.yml$/.test(file)) return false;
  const parts = key.split('/');
  // The root component includes "root", followed by the preset declaration.
  const presetIndex = parts.findIndex(part => part.startsWith('entry:preset-'));
  if (presetIndex < 0 || !presets.has(parts[presetIndex].slice(6))) return false;
  const local = parts.slice(presetIndex + 1).join('/');
  if (local === 'plugins/entry:persona') return at[1] === 'prefix' || (parts[presetIndex] === 'entry:preset-minimal' && at[1] === 'complete');
  if (parts[presetIndex] === 'entry:preset-minimal' && local === 'plugins/entry:persistent-shell/config/entry:persistent-pwsh') return at[1] === 'description';
  return local === 'plugins/entry:planning/config/entry:plan-mode' && at[1] === 'section';
}

function setValue(row, at, value) {
  if (at.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw Error('Invalid private recipe field path');
  let parent = row;
  for (const part of at.slice(0, -1)) {
    if (!own(parent, part) || !parent[part] || typeof parent[part] !== 'object' || Array.isArray(parent[part])) parent[part] = {};
    parent = parent[part];
  }
  if (value === undefined) delete parent[at.at(-1)];
  else parent[at.at(-1)] = clone(value);
}

function reviewedAddition(originalPackage, file, ref) {
  const row = ref.row;
  return originalPackage === '@deepseek-ai/dsh-web-app' && file === 'presets/minimal.patch.yml'
    && ref.key === 'root/entry:preset-minimal/plugins/entry:agent-instructions'
    && row.name === '@deepseek-ai/dsh-agent-instructions'
    && Object.keys(row).sort().join(',') === 'config,id,name'
    && Object.keys(row.config ?? {}).join(',') === 'maxBytes'
    && Number.isSafeInteger(row.config.maxBytes) && row.config.maxBytes > 0 && row.config.maxBytes <= 1024 * 1024;
}

function insertLikeCurrent(targetRefs, currentRefs, ref) {
  const siblings = ref.list;
  let targetList;
  let position = 0;
  for (let i = ref.index - 1; i >= 0; i--) {
    const sibling = currentRefs.get(ref.scope + '/entry:' + siblings[i].id);
    const target = sibling && targetRefs.get(sibling.key);
    if (target) { targetList = target.list; position = target.list.indexOf(target.row) + 1; break; }
  }
  if (!targetList) for (let i = ref.index + 1; i < siblings.length; i++) {
    const sibling = currentRefs.get(ref.scope + '/entry:' + siblings[i].id);
    const target = sibling && targetRefs.get(sibling.key);
    if (target) { targetList = target.list; position = target.list.indexOf(target.row); break; }
  }
  if (!targetList) throw Error('New recipe addition destination is missing: ' + ref.key);
  targetList.splice(position, 0, clone(ref.row));
}

function privateUrl(name, resolvePrivateModule, privateModulesRoot) {
  if (typeof resolvePrivateModule !== 'function' || !path.isAbsolute(privateModulesRoot)) throw Error('Private closure resolver/root required');
  const value = resolvePrivateModule(name);
  let file;
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.search || url.hash || url.host) throw Error('Invalid private module URL');
    file = fileURLToPath(url);
    if (pathToFileURL(file).href !== value) throw Error('Non-canonical private module URL');
  } catch { throw Error('Private module URL must be a canonical file URL'); }
  const relative = path.relative(privateModulesRoot, file);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw Error('Private module resolved outside owned closure');
  return value;
}

/**
 * Pure three-way conversion. The caller owns immutable source/hash admission,
 * filesystem staging, alias ownership metadata, and the final transaction.
 * JS-tag expressions are data handled by the caller's non-evaluating codec.
 */
export function rebasePrivateBundleRecipes({ originalPackage, oldFiles, currentFiles, newFiles, patchNameMappings = [], resolvePrivateModule, privateModulesRoot, parse, dump, expectedCurrentSha256 }) {
  if (!packages.has(originalPackage) || typeof parse !== 'function' || typeof dump !== 'function') throw Error('Unsupported private bundle recipe conversion');
  const table = mappingTable(patchNameMappings), files = {}, transfers = [], addedRows = [], routes = [], inputs = {};
  const oldNames = Object.keys(oldFiles ?? {}).sort(), currentNames = Object.keys(currentFiles ?? {}).sort();
  if (!oldNames.length || !isDeepStrictEqual(oldNames, currentNames)) throw Error('Unrecognized private recipe file roster');
  for (const filename of Object.keys(newFiles ?? {})) safeFilename(filename);
  for (const file of oldNames) {
    safeFilename(file);
    if (!own(newFiles ?? {}, file)) throw Error('New release omitted a private recipe file: ' + file);
    if (expectedCurrentSha256 && expectedCurrentSha256[file] !== hash(currentFiles[file])) throw Error('Unrecognized private recipe file checksum: ' + file);
    const old = readRecipe(oldFiles[file], parse), current = normalizeNames(readRecipe(currentFiles[file], parse), table), next = readRecipe(newFiles[file], parse);
    const expected = clone(old);
    const oldRefs = indexRecipe(old), currentRefs = indexRecipe(current), expectedRefs = indexRecipe(expected), nextRefs = indexRecipe(next);
    for (const [key, original] of oldRefs) {
      const changed = currentRefs.get(key);
      if (!changed) fail(file + ' deleted row ' + key);
      for (const change of leafChanges(ownRow(original.row), ownRow(changed.row))) {
        if (!allowedTransfer(originalPackage, file, key, change.at)) fail(file + ' ' + key + '/' + change.at.join('/'));
        const target = nextRefs.get(key);
        if (!target || target.row.name !== original.row.name) throw Error('New recipe private-value destination changed: ' + key);
        setValue(target.row, change.at, change.after);
        setValue(expectedRefs.get(key).row, change.at, change.after);
        transfers.push({ file, key, field: change.at.join('/'), beforeSha256: hash(JSON.stringify(change.before) ?? 'undefined'), afterSha256: hash(JSON.stringify(change.after) ?? 'undefined') });
      }
    }
    for (const [key, ref] of currentRefs) if (!oldRefs.has(key)) {
      if (!reviewedAddition(originalPackage, file, ref)) fail(file + ' added row ' + key);
      if (nextRefs.has(key)) {
        if (!isDeepStrictEqual(ownRow(nextRefs.get(key).row), ownRow(ref.row))) throw Error('New recipe addition destination conflicts: ' + key);
      } else insertLikeCurrent(nextRefs, currentRefs, ref);
      insertLikeCurrent(expectedRefs, currentRefs, ref);
      addedRows.push({ file, key });
    }
    if (!isDeepStrictEqual(expected, current)) fail(file + ' structure or ordering changed');
    for (const { key, row } of indexRecipe(next).values()) if (builtin(row.name)) {
      const originalName = row.name, privateName = privateUrl(originalName, resolvePrivateModule, privateModulesRoot);
      for (const known of patchNameMappings) if (known.originalId === row.id && known.originalName === originalName && known.privateName !== privateName) throw Error('Registered private plugin URL changed: ' + row.id);
      row.name = privateName;
      routes.push({ file, key, originalId: row.id, originalName, privateName });
    }
    files[file] = dump(next);
    if (!isDeepStrictEqual(readRecipe(files[file], parse), next)) throw Error('Private recipe codec changed semantic values');
    inputs[file] = { oldSha256: hash(oldFiles[file]), currentSha256: hash(currentFiles[file]), newSha256: hash(newFiles[file]), resultSha256: hash(files[file]) };
  }
  // Explicitly retain release-added recipe files; do not silently drop presets.
  for (const file of Object.keys(newFiles).filter(name => !own(files, name))) {
    const next = readRecipe(newFiles[file], parse);
    for (const { key, row } of indexRecipe(next).values()) if (builtin(row.name)) {
      const originalName = row.name, privateName = privateUrl(originalName, resolvePrivateModule, privateModulesRoot);
      row.name = privateName; routes.push({ file, key, originalId: row.id, originalName, privateName });
    }
    files[file] = dump(next);
    if (!isDeepStrictEqual(readRecipe(files[file], parse), next)) throw Error('Private recipe codec changed semantic values');
    inputs[file] = { newSha256: hash(newFiles[file]), resultSha256: hash(files[file]) };
  }
  return { files, transfers, addedRows, routes, inputs };
}

/** Change only plugin-name scalar tokens; caller must transact the resulting bytes. */
export function rewriteProfileBuiltinNames(text, { yamlAst, resolvePrivateModule, privateModulesRoot, patchNameMappings = [] }) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024 || typeof yamlAst?.parseDocument !== 'function') throw Error('Invalid profile recipe input');
  const options = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ __jsExpr: value }) }] };
  const document = yamlAst.parseDocument(text, options);
  if (document.errors.length) throw document.errors[0];
  if (document.contents === null) return { text, edits: [], routes: [] };
  if (!yamlAst.isSeq(document.contents)) throw Error('Profile recipe must be a sequence');
  const table = mappingTable(patchNameMappings), edits = [], routes = [];
  // A custom plugin can legitimately store ordinary data under config.plugins.
  // Only the SDK preset provider declares that field as a nested loader tree.
  const presetNames = new Set(['@deepseek-ai/dsh-agent-preset', privateUrl('@deepseek-ai/dsh-agent-preset', resolvePrivateModule, privateModulesRoot)]);
  const visitRows = node => {
    if (!yamlAst.isSeq(node)) throw Error('Profile plugin list must be a sequence');
    for (const row of node.items) visitRow(row);
  };
  const visitRow = node => {
    if (yamlAst.isMap(node)) {
      const id = node.get('id'), name = node.get('name'), nameNode = node.get('name', true);
      if (typeof id === 'string' && nameNode !== undefined && (!yamlAst.isScalar(nameNode) || typeof name !== 'string')) throw Error('Profile plugin name must be a literal string scalar');
      if (typeof id === 'string' && typeof name === 'string') {
        const known = table.get(id + '\0' + name);
        if (known && privateUrl(known.originalName, resolvePrivateModule, privateModulesRoot) !== name) throw Error('Registered private plugin URL changed: ' + id);
        if (builtin(name)) {
          if (!yamlAst.isScalar(nameNode) || !Array.isArray(nameNode.range)) throw Error('Profile plugin name is not an editable scalar');
          const value = privateUrl(name, resolvePrivateModule, privateModulesRoot);
          edits.push({ start: nameNode.range[0], end: nameNode.range[1], before: text.slice(nameNode.range[0], nameNode.range[1]), after: JSON.stringify(value) });
          routes.push({ originalId: id, originalName: name, privateName: value });
        }
      }
      const insertion = node.get('insert', true);
      if (insertion !== undefined) visitRows(insertion);
      const config = node.get('config', true);
      if (node.get('group') === true && config !== undefined) visitRows(config);
      if (presetNames.has(name) && yamlAst.isMap(config)) {
        const plugins = config.get('plugins', true);
        if (plugins !== undefined) visitRows(plugins);
      }
    } else throw Error('Profile recipe row must be a map');
  };
  visitRows(document.contents);
  edits.sort((a, b) => a.start - b.start);
  let delta = 0;
  for (const edit of edits) { edit.afterStart = edit.start + delta; edit.afterEnd = edit.afterStart + edit.after.length; delta += edit.after.length - (edit.end - edit.start); }
  let output = text;
  for (const edit of [...edits].reverse()) output = output.slice(0, edit.start) + edit.after + output.slice(edit.end);
  const after = yamlAst.parseDocument(output, options);
  if (after.errors.length) throw after.errors[0];
  const expected = document.toJS();
  const expectedNames = new Map(routes.map(row => [row.originalId + '\0' + row.originalName, row.privateName]));
  function normalize(rows) {
    for (const row of rows) {
      const name = expectedNames.get(row.id + '\0' + row.name);
      if (name) row.name = name;
      if (Array.isArray(row.insert)) normalize(row.insert);
      if (row.group === true && Array.isArray(row.config)) normalize(row.config);
      if (presetNames.has(row.name) && Array.isArray(row.config?.plugins)) normalize(row.config.plugins);
    }
  }
  normalize(expected);
  if (!isDeepStrictEqual(after.toJS(), expected)) throw Error('Profile name-token edit changed configuration semantics');
  return { text: output, edits, routes };
}
