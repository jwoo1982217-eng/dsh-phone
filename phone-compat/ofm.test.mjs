import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { applyPhoneCompatibility } from '../app/src/main/assets/dsh-ofm-compat.mjs';
const fixture = JSON.parse(gunzipSync(fs.readFileSync(new URL('./fixtures/upstream-2.5.1.json.gz', import.meta.url))));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ofm-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(fixture)) {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  }
  return root;
}
function snapshot(root) {
  return Object.fromEntries(Object.keys(fixture).map(n => [n, hash(fs.readFileSync(path.join(root, n)))]));
}
test('real upstream program keeps its version and receives phone gate, shared channels and reload retention', t => {
  const root = setup(t);
  const result = applyPhoneCompatibility(root);
  assert.equal(result.version, '2.5.1'); assert.ok(result.changed.includes('src/host-channels.js'));
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), fixture['package.json']);
  assert.match(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), /void mountHostChannels\(scoped/);
  assert.match(fs.readFileSync(path.join(root, 'src/vault.js'), 'utf8'), /FLAVOR_PHONE/);
  assert.match(fs.readFileSync(path.join(root, 'src/reload.js'), 'utf8'), /phone\.applyPhoneCompatibility/);
  assert.deepEqual(applyPhoneCompatibility(root).changed, [], 'repeated startup must not rewrite program files');
});
test('unknown upstream implementation is rejected before any file is changed', t => {
  const root = setup(t);
  fs.appendFileSync(path.join(root, 'client.js'), '\n// unrelated customization remains intact\n');
  const p = path.join(root, 'client.js'); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('function useChannelRpc(ctx)', 'function useChannelRpc(customContext)'));
  const before = snapshot(root);
  assert.throws(() => applyPhoneCompatibility(root), /Unreviewed OFM function/);
  assert.deepEqual(snapshot(root), before); assert.equal(fs.existsSync(path.join(root, 'src/host-channels.js')), false);
});
test('rename failure restores exact previous files and a retry succeeds', t => {
  const root = setup(t), before = snapshot(root); let injected = false;
  const io = { ...fs, renameSync(from, to) {
    if (!injected && to === path.join(root, 'client.js')) { injected = true; throw Error('injected write failure'); }
    return fs.renameSync(from, to);
  } };
  assert.throws(() => applyPhoneCompatibility(root, { io }), /injected write failure/);
  assert.deepEqual(snapshot(root), before); assert.equal(fs.existsSync(path.join(root, 'src/host-channels.js')), false);
  assert.ok(applyPhoneCompatibility(root).changed.length > 0);
});
test('repaired real browser hook sends shared requests to Jet Hub and preserves genuine RPC errors', async t => {
  const root = setup(t); applyPhoneCompatibility(root);
  let bundle;
  new Function('window', fs.readFileSync(path.join(root, 'client.js'), 'utf8'))({ __ModuleLoader__: { load: x => { bundle = x; } } });
  const hook = bundle.factory(() => ({ useMemo: f => f() })).__test.useChannelRpc;
  const calls = [], payload = { providers: ['codearts'] };
  let reject = false;
  const connection = { rpc: { call: async (...args) => {
    calls.push(args.slice(0, 3)); return reject ? { ok: false, error: { message: 'real backend denied' } } : { ok: true, value: { ready: true } };
  } } };
  for (const mode of ['shared', 'shared-legacy', 'embedded']) {
    assert.deepEqual(await hook({ connection }, { channels: { mode } }).rpc('provider.status', payload), { ready: true });
  }
  assert.deepEqual(calls.map(c => c.slice(0, 2)), [['/jet-hub', 'manage'], ['/api', 'jet-hub'], ['/api', 'channel-pack']]);
  assert.deepEqual(calls[0][2], { method: 'provider.status', payload });
  reject = true; await assert.rejects(hook({ connection }, { channels: { mode: 'shared' } }).rpc('provider.status', {}), /real backend denied/);
});

const fixture253 = JSON.parse(gunzipSync(fs.readFileSync(new URL('./fixtures/upstream-2.5.3.json.gz', import.meta.url))));
function setup253(t) {
  const root = setup(t);
  for (const [name, text] of Object.entries(fixture253)) fs.writeFileSync(path.join(root, name), text);
  return root;
}
function reactiveHook(root) {
  let bundle, cursor = 0;
  const slots = [], effects = [];
  const react = {
    useRef(value) { const i=cursor++; return slots[i] ??= { current: value }; },
    useState(value) { const i=cursor++; if (!(i in slots)) slots[i]=typeof value==='function'?value():value;
      return [slots[i], next => { slots[i]=typeof next==='function'?next(slots[i]):next; }]; },
    useCallback(fn, deps) { const i=cursor++; const old=slots[i]; if(!old || deps.some((x,j)=>x!==old.deps[j])) slots[i]={fn,deps}; return slots[i].fn; },
    useEffect(fn, deps) { const i=cursor++; const old=slots[i]; if(!old || deps.some((x,j)=>x!==old.deps[j])) {
      old?.cleanup?.(); const slot={deps}; slots[i]=slot; effects.push(()=>{slot.cleanup=fn();});
    } },
  };
  new Function('window', fs.readFileSync(path.join(root,'client.js'),'utf8'))({__ModuleLoader__:{load:x=>{bundle=x;}}});
  const hook=bundle.factory(()=>react).__test.useChannelRpc;
  return { render(ctx, mode) { cursor=0; const result=hook(ctx,{channels:{mode}}); while(effects.length)effects.shift()(); return result; },
    close() {for(const slot of slots)slot?.cleanup?.();} };
}
test('2.5.3 keeps reactive connection discovery, replacement, binding and all channel routes', async t => {
  const root=setup253(t); assert.equal(applyPhoneCompatibility(root).version,'2.5.3');
  assert.deepEqual(applyPhoneCompatibility(root).changed,[]);
  const runner=reactiveHook(root);t.after(()=>runner.close());const ctx={};
  assert.equal(runner.render(ctx,'shared').available,false);
  const calls=[];let denied=false;
  function transport(label) {const rpc={label,async call(...args){assert.equal(this,rpc);calls.push([label,...args.slice(0,3)]);return denied?{ok:false,error:{message:'backend denied'}}:{ok:true,value:label};}};return{rpc};}
  ctx.connection=transport('late');
  await new Promise(resolve=>setTimeout(resolve,520));
  let state=runner.render(ctx,'shared');assert.equal(state.available,true);
  assert.equal(await state.rpc('provider.status',{}),'late');assert.ok(state.rpc.transport());
  ctx.connection=transport('replacement');
  assert.equal(await state.rpc('provider.status',{}),'replacement','old reader discovers replacement without a context rerender');
  for(const mode of ['shared-legacy','embedded'])await runner.render(ctx,mode).rpc('provider.status',{});
  assert.deepEqual(calls.map(c=>c.slice(1,3)),[['/jet-hub','manage'],['/jet-hub','manage'],['/api','jet-hub'],['/api','channel-pack']]);
  denied=true;await assert.rejects(runner.render(ctx,'shared').rpc('provider.status',{}),/backend denied/);
});
test('2.5.3 preserves validated URLs, awaited desktop opening, 30s login and responsive manual link', async t=>{
  const root=setup253(t);applyPhoneCompatibility(root);
  const client=fs.readFileSync(path.join(root,'client.js'),'utf8');
  assert.ok(client.includes("post('/eac/login/start', undefined, 30_000)"));
  assert.ok(client.includes("minWidth: 0, overflowWrap: 'anywhere'"));
  const {externalUrl,openExternal}=await import(new URL('file://'+root+'/src/open-external.js'));
  assert.equal(externalUrl('javascript:alert(1)'),null);assert.equal(externalUrl('https://user:pass@example.com'),null);
  let launched=false;assert.equal(await openExternal('https://example.com',{platform:'android',exec:async()=>{launched=true;}}),false);assert.equal(launched,false);
  assert.equal(await openExternal('https://example.com',{platform:'darwin',exec:async(cmd,args)=>{assert.equal(cmd,'/usr/bin/open');assert.deepEqual(args,['https://example.com/']);launched=true;}}),true);assert.equal(launched,true);
  assert.equal(await openExternal('https://example.com',{platform:'darwin',exec:async()=>{throw Error('missing browser');}}),false);
});
test('2.5.3 actual settings shell supplies resolved server data to every channel RPC page', t=>{
  const root=setup253(t);applyPhoneCompatibility(root);
  const source=fs.readFileSync(path.join(root,'client.js'),'utf8').replace('exports.__test = {','exports.__test = { Shell,');
  const data={channels:{state:'ready',mode:'shared'},catalog:[{availability:'unavailable'},{channel:'kilo'},{channel:'eac'},{channel:'aggregate'}],settings:{}};
  for(const tab of ['channels','ledger','logs','gateway']){
    let bundle;
    new Function('window',source)({localStorage:{getItem:()=>tab},__ModuleLoader__:{load:x=>{bundle=x;}}});
    const react={createElement:(type,props,...children)=>({type,props,children}),useState:v=>[typeof v==='function'?v():v,()=>{}],useRef:v=>({current:v}),useEffect(){},useMemo:fn=>fn()};
    const node=bundle.factory(()=>react).__test.Shell({data,summary:{data,reload(){}},t:k=>k,counts:{}});
    const page=node.children.at(-1);assert.equal(page.props.summary,data,tab+' must receive resolved data');
    const findFree = value => Array.isArray(value) ? value.map(findFree).find(Boolean)
      : value && typeof value==='object' ? value.type==='button' && value.children[0]==='nav.tab.free' ? value : findFree(value.children) : undefined;
    assert.equal(findFree(node).children[1].children[0],'2','free badge counts the anonymous and Kilo directory, excluding EAC and paid aggregators');
  }
});
