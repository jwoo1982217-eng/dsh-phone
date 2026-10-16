import fs from 'node:fs';
import path from 'node:path';

export function files(root) {
  let entries;
  try { entries=fs.readdirSync(root,{withFileTypes:true}); }
  catch(error) { if(error.code==='ENOENT')return [];throw error; }
  return entries.flatMap(entry => entry.isDirectory()
    ? files(path.join(root, entry.name)) : entry.isFile() ? [path.join(root, entry.name)] : []);
}
const hashes = value => value.match(/\b[a-f0-9]{64}\b/g) || [];
const logs = home => ['sessions','sessions-backup-old-account'].flatMap(root => files(path.join(home,root)))
  .filter(file => /\/session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(file));

export function targetHashes(home, persistence, ids) {
  const result = new Set();
  for (const file of logs(home)) {
    if (!ids.has(path.basename(path.dirname(file)))) continue;
    for (const h of hashes(persistence.decodeDeletionLog(fs.readFileSync(file),file.endsWith('.zstd')))) result.add(h);
  }
  return result;
}

// Read only after the host has no running tasks. Include events whose writer
// has not flushed yet, as well as all physical generations and QQ backups.
export function cleanAttachments(home, ctx, candidates) {
  const retained = new Set();
  for (const file of logs(home)) {
    for (const h of hashes(ctx.sessionPersistence.decodeDeletionLog(fs.readFileSync(file),file.endsWith('.zstd')))) retained.add(h);
  }
  for (const session of ctx.sessions.list()) {
    for (const event of session.snapshotEvents()) for (const h of hashes(JSON.stringify(event))) retained.add(h);
  }
  for (const root of ['attachments','cache/attachments']) for (const file of files(path.join(home,root))) {
    const refs = hashes(file);
    if (refs.some(h => candidates.has(h)) && !refs.some(h => retained.has(h))) fs.rmSync(file);
  }
}
