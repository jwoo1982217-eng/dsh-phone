import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const [home, tree, archiveFile, mode] = process.argv.slice(2);
const { installTrial } = await import(pathToFileURL(path.join(tree, 'node_modules/dsh-peer/controlled-market/install-trial.mjs')));
const archive = await readFile(archiveFile);
const { createHash } = await import('node:crypto');
const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
const plan = { source: 'npm', name: 'fixture-phone-trial', version: '1.0.0', hostVersion: '0.2.1-alpha.1',
  download: 'https://registry.npmjs.org/fixture-phone-trial/-/fixture-phone-trial-1.0.0.tgz', integrity: mode === 'bad' ? 'sha512-' + 'A'.repeat(86) + '==' : integrity };
try {
  const result = await installTrial(plan, { home, tree, fetchImpl: async () => new Response(archive) });
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
