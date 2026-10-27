import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('process exit after admission but before its response leaves a private candidate journal that restart cleans', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'peer-process-recovery-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const admissions = new Set(); let activeChild, interruptAfterPost = false;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/health') { res.writeHead(200).end(); return; }
    if (req.headers.authorization !== 'Bearer synthetic-private-admin-credential') { res.writeHead(401).end(); return; }
    if (req.method === 'POST') {
      admissions.add(JSON.parse(Buffer.concat(chunks)).room);
      if (interruptAfterPost) { activeChild.kill('SIGKILL'); req.socket.destroy(); return; }
      res.writeHead(201).end(); return;
    }
    if (req.method === 'DELETE') { admissions.delete(req.url.split('/').at(-1)); res.writeHead(200).end(); return; }
    res.writeHead(404).end();
  });
  const port = await listen(server), stateFile = join(dir, 'credentials.json'), childFile = join(dir, 'child.mjs');
  t.after(async () => { activeChild?.kill('SIGKILL'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const source = `
import {apply} from ${JSON.stringify(new URL('./index.mjs', import.meta.url).href)};
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const stateFile=${JSON.stringify(stateFile)}, hooks=new Map(),rpcs=new Map(),services=new Map(),disposers=[];
const values=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{};
const credentials={resolve:async ref=>Object.hasOwn(values,String(ref))?{value:values[String(ref)]}:undefined,set:async(ref,value)=>{values[String(ref)]=value;writeFileSync(stateFile+'.tmp',JSON.stringify(values),{mode:0o600});renameSync(stateFile+'.tmp',stateFile)}};
const registration=()=>{};registration.replace=()=>{};
const ctx={credentials,settings:{describe:()=>[]},llm:{registerAdapter:()=>registration},systemPrompt:{variable(){},context(){}},connection:{rpc:{handle(path,fn){rpcs.set(path,fn)}}},webServer:{register(){return()=>{}}},get(name){return services.get(name)??this[name]},provide(name,value){services.set(name,value)},inject(names,fn){if(names.every(name=>this.get(name)!==undefined))return fn(this)},effect(fn){const d=fn();if(typeof d==='function')disposers.push(d)},on(name,fn){hooks.set(name,fn)}};
await apply(ctx,{role:'computer',sharedGatewayPort:0});
const manage=(action,extra={})=>rpcs.get('/phone-peer')('manage',{action,...extra});
if(process.argv[2]==='initial') { const configured=await manage('remote.configure',{relay:'ws://127.0.0.1:${port}/relay',adminKey:'synthetic-private-admin-credential'});if(!configured.ok)throw Error(configured.error.code); }
const result=await manage(process.argv[2]==='rotate'?'create':'prepare');
const saved=JSON.parse(values.DSH_PEER_PAIR_V1),primaryRoomHash=createHash('sha256').update(saved.pair.room).digest('hex');
await hooks.get('dispose')?.();for(const fn of disposers.reverse())await fn();
console.log(JSON.stringify({ok:result.ok,errorCode:result.error?.code,primaryRoomHash,pending:saved.pendingRevocations?.length??0}));
`;
  await writeFile(childFile, source);
  const phoneLoader = fileURLToPath(new URL('../scripts/phone-test-imports.mjs', import.meta.url));
  const loader = existsSync(phoneLoader) ? phoneLoader : fileURLToPath(new URL('../scripts/desktop-test-imports.mjs', import.meta.url));
  const run = mode => new Promise(resolve => {
    activeChild = execFile(process.execPath, ['--import', loader, childFile, mode], { env: { ...process.env, DSH_HOME: join(dir, 'home') }, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => { activeChild = null; resolve({ error, stdout, stderr }); });
  });
  const firstProcess = await run('initial'); assert.equal(firstProcess.error, null, firstProcess.stderr);
  const original = JSON.parse(firstProcess.stdout); assert.equal(original.ok, true); assert.equal(admissions.size, 1);
  interruptAfterPost = true; const interrupted = await run('rotate'); assert.equal(interrupted.error.signal, 'SIGKILL');
  const privateState = JSON.parse(JSON.parse(await readFile(stateFile, 'utf8')).DSH_PEER_PAIR_V1);
  assert.equal(privateState.pendingRevocations.length, 1); assert.equal(admissions.has(privateState.pendingRevocations[0].room), true); assert.equal(admissions.size, 2);
  interruptAfterPost = false; const recoveredProcess = await run('restart'); assert.equal(recoveredProcess.error, null, recoveredProcess.stderr);
  const recovered = JSON.parse(recoveredProcess.stdout); assert.equal(recovered.ok, true); assert.equal(recovered.primaryRoomHash, original.primaryRoomHash); assert.equal(recovered.pending, 0); assert.equal(admissions.size, 1);
});
