import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {canonicalPath,projectScope,isolatedStore,typedInput,provenance,assertStateScope,methodDigest,episodeDigest,projectReference} from './isolation.mjs';

const now = () => new Date().toISOString();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (ok, message) => { if (!ok) throw Error(message); };
const text = (s, label) => { assert(typeof s === 'string' && s.trim() && s.length <= 16000, `${label}: nonempty text required (max 16000)`); return s.trim(); };
const read = file => {
  const fd = fs.openSync(path.resolve(file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const s = fs.fstatSync(fd); assert(s.isFile() && s.size <= 4 * 1024 * 1024, 'Evidence/input must be a regular file <=4MB'); return fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
};
const input = file => JSON.parse(read(file).toString('utf8'));
const snapshot = file => { const resolved = path.resolve(text(file, 'evidence path')); return { path: resolved, sha256: hash(read(resolved)) }; };
function pointer(value, p) {
  assert(typeof p === 'string' && (p === '' || p.startsWith('/')), 'Invalid JSON pointer');
  if (!p) return value;
  for (const segment of p.slice(1).split('/')) {
    assert(!/~(?![01])/.test(segment), 'Invalid JSON pointer escape');
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    assert(value !== null && typeof value === 'object' && Object.hasOwn(value, key), `Missing JSON pointer: ${p}`);
    value = value[key];
  }
  return value;
}
function checkCase(c, previousHash) {
  const bytes = read(c.evidence), digest = hash(bytes);
  assert(!previousHash || previousHash === digest, `Evidence changed: ${c.name}`);
  assert(Array.isArray(c.checks) && c.checks.length > 0 && c.checks.length <= 32, 'Each case needs 1..32 checks');
  for (const check of c.checks) {
    assert(Object.hasOwn(check, 'expected'), 'Missing expected value');
    if (check.type === 'json-equals') assert(isDeepStrictEqual(pointer(JSON.parse(bytes.toString('utf8')), check.pointer), check.expected), `JSON check failed: ${c.name} ${check.pointer}`);
    else if (check.type === 'text-includes') { assert(typeof check.expected === 'string' && check.expected.length > 0, 'Empty text check'); assert(bytes.toString('utf8').includes(check.expected), `Text check failed: ${c.name}`); }
    else if (check.type === 'sha256') { assert(/^[a-f0-9]{64}$/.test(check.expected), 'Invalid SHA256'); assert(digest === check.expected, `SHA256 check failed: ${c.name}`); }
    else throw Error(`Unsupported check: ${check.type}`);
  }
  return digest;
}
function normalizeCases(payload, episode) {
  assert(Array.isArray(payload.cases) && payload.cases.length >= 3 && payload.cases.length <= 30, 'Need 3..30 cases');
  const cases = payload.cases.map(c => ({ name: text(c.name, 'case name'), kind: c.kind, evidence: path.resolve(text(c.evidence, 'evidence')), checks: c.checks }));
  for (const kind of ['normal', 'boundary', 'failure']) assert(cases.some(c => c.kind === kind), `Missing ${kind} case`);
  assert(cases.every(c => ['normal', 'boundary', 'failure'].includes(c.kind)), 'Invalid case kind');
  assert(cases.some(c => c.kind === 'normal' && episode.evidence.some(e => e.path === c.evidence)), 'A normal case must use actual episode evidence');
  return cases;
}
const blank = scope => ({ version: 3, scope, revision: 0, episodes: [], candidates: [], current: {}, events: [] });
const findCandidate = (s, id) => { const c = s.candidates.find(c => c.id === id); assert(c, 'Candidate not found'); return c; };
const active = (s, key) => Object.hasOwn(s.current, key) ? s.current[key] : null;
function operation(s, command, args) {
  if (command === 'record') {
    const p = input(args[0]);
    typedInput(p,['task','outcome','result','errors','evidence','provenance','kind'],'task-observation');
    assert(['completed', 'partial', 'failed'].includes(p.outcome), 'Invalid outcome');
    assert(Array.isArray(p.errors) && Array.isArray(p.evidence) && p.evidence.length > 0 && p.evidence.length <= 30, 'Need errors array and 1..30 evidence files');
    const episode = { id: randomUUID(), at: now(), kind:'task-observation',scope:s.scope,provenance:provenance(p.provenance),task: text(p.task, 'task'), outcome: p.outcome, result: text(p.result, 'result'), errors: p.errors.map(e => text(e, 'error')), evidence: p.evidence.map(snapshot) };
    episode.integrity=episodeDigest(episode);s.episodes.push(episode); return episode;
  }
  if (command === 'propose') {
    const p = input(args[0]); assert(s.episodes.some(e => e.id === p.episodeId), 'Episode not found');
    typedInput(p,['episodeId','key','trigger','action','exclusions','change','kind'],'project-method');
    assert(typeof p.key === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(p.key), 'Invalid method key');
    const c = { id: randomUUID(), at: now(), kind:'project-method',scope:s.scope,episodeId: p.episodeId, key: p.key, trigger: text(p.trigger, 'trigger'), action: text(p.action, 'action'), exclusions: text(p.exclusions, 'exclusions'), change: text(p.change, 'change'), base: active(s, p.key), status: 'proposed' };
    s.candidates.push(c); return c;
  }
  if (command === 'validate') {
    const c = findCandidate(s, args[0]); assert(!c.approvedAt, 'Approved versions are immutable; propose a new version');
    try {
      const cases = normalizeCases(input(args[1]), s.episodes.find(e => e.id === c.episodeId));
      c.validation = { at: now(), passed: true, cases: cases.map(x => ({ ...x, sha256: checkCase(x) })) };
      c.status = 'validated';
    } catch (error) {
      c.validation = { at: now(), passed: false, error: error.message }; c.status = 'rejected';
    }
    return { id: c.id, ...c.validation };
  }
  if (command === 'promote') {
    const c = findCandidate(s, args[0]);
    assert(c.status === 'validated' && c.validation?.passed && !c.approvedAt, 'Candidate has not passed validation');
    assert(active(s, c.key) === c.base, 'Baseline changed; propose and validate against current version');
    const episode=s.episodes.find(e => e.id === c.episodeId);assert(episode.integrity===episodeDigest(episode),'Episode source record changed');
    for (const evidence of episode.evidence) assert(hash(read(evidence.path)) === evidence.sha256, 'Episode evidence changed; record current task evidence again');
    for (const v of c.validation.cases) checkCase(v, v.sha256);
    c.approvedAt = now(); c.status = 'approved'; s.current[c.key] = c.id;
    c.episodeDigest=episode.integrity;c.approvalDigest=methodDigest(c);
    s.events.push({ at: now(), action: 'promote', id: c.id, previous: c.base }); return c;
  }
  if (command === 'rollback') {
    const id = active(s, args[0]); assert(id, 'No current method to roll back');
    const c = findCandidate(s, id), reason = text(args.slice(1).join(' '), 'rollback reason');
    if (c.base) { const old = findCandidate(s, c.base); assert(old.status==='approved'&&old.approvedAt&&!old.revokedAt&&old.approvalDigest===methodDigest(old), 'Previous approved version is unavailable or changed'); s.current[c.key] = c.base; }
    else delete s.current[c.key];
    c.revokedAt = now(); c.status = 'rolled-back';
    s.events.push({ at: now(), action: 'rollback', id, restored: c.base, reason }); return { rolledBack: id, restored: c.base, reason };
  }
  if (command === 'quarantine') {
    const c=findCandidate(s,args[0]),reason=text(args.slice(1).join(' '),'quarantine reason');
    c.quarantinedAt=now();c.status='quarantined';
    if(active(s,c.key)===c.id)delete s.current[c.key];
    s.events.push({at:now(),action:'quarantine',id:c.id,reason});
    return {id:c.id,quarantined:true,reason};
  }
  if (command === 'audit') return {scope:s.scope,revision:s.revision,episodes:s.episodes,candidates:s.candidates.map(c=>({...c,integrity:!c.approvedAt||c.approvalDigest===methodDigest(c)})),current:s.current,events:s.events};
  if (command === 'search') {
    const q = args.join(' ').toLowerCase();
    return Object.values(s.current).map(id => findCandidate(s, id))
      .filter(c => {const e=s.episodes.find(e=>e.id===c.episodeId);return c.status==='approved'&&c.approvedAt&&!c.revokedAt&&c.approvalDigest===methodDigest(c)&&e&&c.episodeDigest===episodeDigest(e)&&[c.key, c.trigger, c.action, c.exclusions].join(' ').toLowerCase().includes(q)})
      .map(c=>projectReference(c,s.episodes.find(e=>e.id===c.episodeId)));
  }
  if (command === 'show') { const item = [...s.episodes, ...s.candidates].find(x => x.id === args[0]); assert(item, 'Record not found'); return item; }
  if (command === 'status') return { revision: s.revision, scope:s.scope,referenceOnly:true,episodes: s.episodes.length, candidates: s.candidates.length, approved: Object.keys(s.current).length, current: s.current };
  throw Error('Unknown command');
}
export function run(argv) {
  const flags = {}; let pos = 0;
  while (argv[pos]?.startsWith('--')) { const key = argv[pos++]; assert(['--store', '--runtime','--project','--window'].includes(key), 'Use --store, --runtime, --project or --window'); assert(!Object.hasOwn(flags,key),'Duplicate flag');flags[key] = argv[pos++]; assert(flags[key], 'Missing flag value'); }
  const [command, ...args] = argv.slice(pos);
  assert(command, 'Usage: journal.mjs --runtime codex|dsh record|propose|validate|promote|rollback|search|show|status [args]');
  const runtime = flags['--runtime']; assert(flags['--store'] || ['codex', 'dsh'].includes(runtime), 'Specify --runtime codex|dsh or --store');
  const home = runtime === 'codex' ? process.env.CODEX_HOME || path.join(os.homedir(), '.codex') : process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const managedWindow=runtime==='dsh'?process.env.DSH_SESSION_ID:undefined;
  const managedProject=runtime==='dsh'?process.env.DSH_MEMORY_PROJECT:undefined;
  assert(!managedWindow||!flags['--window']||managedWindow===flags['--window'],'Cannot switch away from the current managed window');
  assert(!managedProject||!flags['--project']||canonicalPath(flags['--project'])===canonicalPath(managedProject),'Cannot switch away from the current managed project');
  const window=managedWindow||flags['--window']||(flags['--store']?'fixture':runtime==='codex'?'codex-local':undefined);
  assert(window,'DSH_SESSION_ID required; use this from the current DSH window');
  const scope=projectScope(managedProject||flags['--project'],window);
  const root = isolatedStore(home,scope,flags['--store']);
  const file = path.join(root, 'state.json'), lock = path.join(root, '.lock');
  const writing = ['record', 'propose', 'validate', 'promote', 'rollback','quarantine'].includes(command);
  assert(writing || ['status', 'search', 'show','audit'].includes(command), 'Unknown command');
  if(fs.existsSync(path.join(home,'experience/verified-improvement','.frozen.json'))){
    assert(!writing,'Experience learning is frozen in Memory Isolation settings');
    if(command==='search')return [];
    if(command==='status')return {scope,frozen:true,approved:0,referenceOnly:true};
  }
  if(fs.existsSync(path.join(root,'.quarantine.json'))){
    assert(!writing,'This window is quarantined; review it in Memory Isolation settings');
    if(command==='search')return [];
    if(command==='status')return {scope,quarantined:true,referenceOnly:true,approved:0};
  }
  if (!fs.existsSync(root)) {
    if (!writing) { const result = operation(blank(scope), command, args); return result; }
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  assert(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink(), 'Store must be a real directory');
  let locked = false, temporary;
  try {
    if (writing) { try { fs.mkdirSync(lock, { mode: 0o700 }); locked = true; } catch (error) { if (error.code === 'EEXIST') throw Error('Journal busy; preserve lock and retry after writer exits'); throw error; } }
    const s = fs.existsSync(file) ? input(file) : blank(scope);
    assertStateScope(s,scope);
    const result = operation(s, command, args);
    if (writing) {
      s.events.push({at:now(),action:command,window:scope.window.id,id:result?.id??null,input:args[0]&&['record','propose'].includes(command)?snapshot(args[0]):undefined});
      s.revision++;
      const bytes = JSON.stringify(s, null, 2) + '\n'; assert(Buffer.byteLength(bytes) <= 4 * 1024 * 1024, 'Journal reached 4MB; archive with a verified migration, do not truncate');
      const history=path.join(root,'checkpoints');
      fs.mkdirSync(history,{recursive:true,mode:0o700});
      assert(!fs.lstatSync(history).isSymbolicLink(),'Checkpoint directory cannot be a symlink');
      if(fs.existsSync(file)){
        const checkpoint=path.join(history,String(s.revision-1)+'.json');
        if(fs.existsSync(checkpoint))assert(hash(read(checkpoint))===hash(read(file)),'Checkpoint content mismatch');
        else fs.copyFileSync(file,checkpoint,fs.constants.COPYFILE_EXCL);
      }
      const checkpoints=fs.readdirSync(history).filter(x=>/^\d+\.json$/.test(x)).sort((a,b)=>Number(a.slice(0,-5))-Number(b.slice(0,-5)));
      for(const old of checkpoints.slice(0,-20))fs.unlinkSync(path.join(history,old));
      temporary = path.join(root, '.state-' + randomUUID());
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file); temporary = undefined;
      const directory = fs.openSync(root, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    return result;
  } finally { if (temporary) fs.unlinkSync(temporary); if (locked) fs.rmdirSync(lock); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = run(process.argv.slice(2)); process.stdout.write(JSON.stringify(result) + '\n'); if (result?.passed === false) process.exitCode = 2; }
  catch (error) { process.stderr.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1; }
}
