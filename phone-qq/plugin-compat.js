import { readFile, writeFile, mkdir, realpath, lstat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// whale-girl 0.1.0 uses the former jobs API. Adapt only the inspected release;
// never change the SDK or guess at a different third-party package revision.
// Upstream: https://github.com/vlln/whale-girl (MIT).
const ORIGINAL = '786e67c4762683d614b8989942a0892b1504a872aa74f7fcf5b9e8ea3e3b885a';
const digest = data => createHash('sha256').update(data).digest('hex');
const MARKER = '// DSH phone whale-girl jobs adapter v1';

export function adaptWhaleGirlSource(source) {
  const replacements = [
    ['    for (const snapshot of jobs.list(agent)) {',
      "    const owner = agent.session?.id\n    if (typeof owner !== 'string') continue\n    for (const snapshot of jobs.list(owner)) {"],
    ['      ctx.jobs.onJobDone((snapshot) => {',
      "      ctx.jobs.events.subscribe({ owners: 'scope' }, (event) => {\n        if (event.type !== 'settled') return\n        const snapshot = event.job"],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw Error('whale-girl source does not match the inspected API');
    source = source.replace(before, after);
  }
  return MARKER + '\n' + source;
}

const CLIENT_ORIGINAL = '7b9d2c7bce0c1deb943cd760589c052eee53382a4bb438837e1a55496daf1d05';
const CLIENT_MARKER = '// DSH phone whale-girl menu adapter v1';
export function adaptWhaleGirlClient(source) {
  const before = '    menu.style.display = next ? "flex" : "none";\n    if (next) {';
  if (source.split(before).length !== 2) throw Error('whale-girl client does not match the inspected menu');
  return CLIENT_MARKER + '\n' + source.replace(before, `    menu.style.display = next ? "flex" : "none";
    if (next) {
      const rect = host.getBoundingClientRect();
      const view = window.visualViewport;
      const minX = (view?.offsetLeft ?? 0) + 8;
      const minY = (view?.offsetTop ?? 0) + 8;
      const width = view?.width ?? window.innerWidth;
      const height = view?.height ?? window.innerHeight;
      const menuW = menu.offsetWidth, menuH = menu.offsetHeight;
      const x = Math.max(minX, Math.min(rect.left + (rect.width - menuW) / 2, minX + width - menuW - 16));
      const below = rect.bottom + 12;
      const preferred = below + menuH <= minY + height - 16 ? below : rect.top - menuH - 12;
      const y = Math.max(minY, Math.min(preferred, minY + height - menuH - 16));
      menu.style.left = (x - rect.left) + 'px';
      menu.style.top = (y - rect.top) + 'px';
      menu.style.bottom = 'auto';
      menu.style.transform = 'none';`);
}
const ADAPTERS = [
  { entry: 'lib/index.mjs', original: ORIGINAL, marker: MARKER, transform: adaptWhaleGirlSource },
  { entry: 'lib/client.js', original: CLIENT_ORIGINAL, marker: CLIENT_MARKER, transform: adaptWhaleGirlClient },
];

async function atomic(file, source) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, source, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function adaptPhonePlugins(tree, home) {
  const sdk = JSON.parse(await readFile(path.join(tree, 'node_modules/@deepseek-ai/dsh-jobs/package.json')));
  if (sdk.version !== '0.2.1-alpha.1') return { adapted: [], skipped: ['SDK version is outside the inspected compatibility range'] };
  const canonicalHome = await realpath(home), seen = new Set(), adapted = [], skipped = [];
  for (const base of ['profiles/phone', 'profiles', '.']) {
    const packagePath = path.join(home, base, 'node_modules/whale-girl');
    let directory;
    try { directory = await realpath(packagePath); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!directory.startsWith(canonicalHome + path.sep)) { skipped.push('whale-girl outside phone home'); continue; }
    if (seen.has(directory)) continue;
    seen.add(directory);
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json')));
    if (metadata.name !== 'whale-girl' || metadata.version !== '0.1.0') { skipped.push('whale-girl version is not inspected'); continue; }
    for (const adapter of ADAPTERS) {
      const file = path.join(directory, adapter.entry);
      const stat = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat === null) continue;
      if (!stat.isFile() || stat.isSymbolicLink() || await realpath(file) !== file) { skipped.push('whale-girl entry is not a contained regular file'); continue; }
      const before = await readFile(file, 'utf8');
      const backup = path.join(canonicalHome, '.phone-plugin-backups/whale-girl-0.1.0', adapter.original + '.mjs');
      if (before.startsWith(adapter.marker + '\n')) {
        // A marker alone never authorizes accepting an altered package.
        const saved = await readFile(backup, 'utf8').catch(() => null);
        if (saved !== null && digest(saved) === adapter.original && before === adapter.transform(saved)) continue;
        skipped.push('whale-girl adapter differs from the recoverable inspected version'); continue;
      }
      if (digest(before) !== adapter.original) { skipped.push('whale-girl source differs from the inspected release'); continue; }
      const after = adapter.transform(before);
      const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: after, encoding: 'utf8', timeout: 10000 });
      if (checked.status !== 0) throw Error('whale-girl adapter failed syntax validation; original retained');
      await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
      try { await writeFile(backup, before, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (digest(await readFile(backup)) !== adapter.original) throw Error('whale-girl backup differs; original retained');
      if (digest(await readFile(file)) !== adapter.original) throw Error('whale-girl changed concurrently; original retained');
      await atomic(file, after);
      adapted.push('whale-girl@0.1.0');
    }
  }
  return { adapted: [...new Set(adapted)], skipped };
}
