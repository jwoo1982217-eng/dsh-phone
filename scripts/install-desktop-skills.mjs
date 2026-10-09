// Import data and attachments only. Do not execute scripts from the ZIP.
import { readFile, mkdir, writeFile, lstat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { inspectPack } from '../phone-qq/packs.js';
const [input, destination] = process.argv.slice(2);
if (!input || !destination) throw Error('Usage: node scripts/install-desktop-skills.mjs pack.zip /path/to/.dsh/skills');
const root = path.resolve(destination), pack = inspectPack(await readFile(input));
await mkdir(root, { recursive: true });
if ((await lstat(root)).isSymbolicLink()) throw Error('Skill destination must not be a symlink');
for (const skill of pack.skills) {
  const target = path.join(root, skill.name), staging = path.join(root, '.import-' + skill.name);
  try { await lstat(target); throw Error(`Existing skill preserved; choose a separate destination: ${skill.name}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rm(staging, { recursive: true, force: true }); await mkdir(staging, { mode: 0o700 });
  try {
    for (const [relative, bytes] of pack.assets) {
      if (!relative.startsWith(skill.directory + '/')) continue;
      const name = relative.slice(skill.directory.length + 1), file = path.join(staging, name === 'SKILL.md' ? 'SOURCE-SKILL.md' : name);
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes, { mode: 0o600 });
    }
    const body = pack.assets.get(skill.directory + '/PHONE-INSTRUCTIONS.md');
    const header = `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\ndisable-model-invocation: ${!skill.modelInvocable}\n---\n`;
    await writeFile(path.join(staging, 'SKILL.md'), header + body.toString('utf8'), { mode: 0o600 });
    await rename(staging, target);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ installed: pack.skills.length, attachmentFiles: pack.assets.size - pack.prompts.length, sha256: pack.hash, renamed: pack.skills.filter(s => s.name !== s.originalName).map(s => ({ name: s.name, originalName: s.originalName })) }));
