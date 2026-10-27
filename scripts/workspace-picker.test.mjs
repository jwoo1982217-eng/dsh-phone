import {frontendShared} from './fixtures/frontend-shared.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const bridgeSource = await readFile(path.join(root, 'app/src/main/assets/dsh-workspace-picker.js'), 'utf8');
const overlaySource = await readFile(path.join(root, 'runtime/overlays/@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js'), 'utf8');
const report = process.env.DSH_WORKSPACE_TEST_REPORT ?? path.join(os.tmpdir(), 'dsh-workspace-picker');
await mkdir(report, { recursive: true });
function fixture(url = 'http://127.0.0.1:3080/chat', { frame = false, crypto = webcrypto, existing } = {}) {
  let current = new URL(url), failNavigation = false;
  const links = [], timers = new Map(), listeners = new Map(); let timer = 0;
  const location = { get href() { return current.href; }, set href(value) { if (failNavigation) throw Error('fixture navigation unavailable'); links.push(value); }, get origin() { return current.origin; } };
  const window = { location, crypto, setTimeout(fn) { timers.set(++timer, fn); return timer; }, clearTimeout(id) { timers.delete(id); }, addEventListener(name, fn) { listeners.set(name, fn); } };
  window.window = window; window.top = frame ? {} : window;
  if (existing) window.__DSH_DIRECTORY_PICKER__ = existing;
  const context = vm.createContext({ window, location, crypto, URL, Uint8Array, Map, Error, Promise, Object, RegExp, String, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout });
  context.globalThis = window;
  const install = () => vm.runInContext(bridgeSource, context);
  install();
  return { window, links, timers, install, navigate: url => current = new URL(url), setFailure: value => failNavigation = value, event: name => listeners.get(name)?.(), expire: () => { for (const [id,fn] of [...timers]) { timers.delete(id); fn(); } } };
}
function hook(f) { assert.equal(typeof f.window.__DSH_DIRECTORY_PICKER__?.pick, 'function', 'local main-page SAF hook must be installed'); return f.window.__DSH_DIRECTORY_PICKER__; }
function id(f) { const url = new URL(f.links.at(-1)); assert.equal(url.hostname, 'workspace'); assert.equal(url.pathname, '/pick'); const id = url.searchParams.get('id'); assert.match(id, /^[a-f0-9]{32}$/); assert.equal([...url.searchParams].length, 1); return id; }

test('bridge installs only on trusted top-level main page and preserves existing native hosts', () => {
  hook(fixture());
  for (const url of ['http://127.0.0.1:3081/', 'https://127.0.0.1:3080/', 'http://user:pw@127.0.0.1:3080/', 'http://localhost:3080/', 'https://example.org/']) assert.equal(fixture(url).window.__DSH_DIRECTORY_PICKER__, undefined, url);
  assert.equal(fixture(undefined, { frame: true }).window.__DSH_DIRECTORY_PICKER__, undefined);
  const existing = { pick() {} }; assert.equal(fixture(undefined, { existing }).window.__DSH_DIRECTORY_PICKER__, existing);
});
test('bridge uses opaque random tickets and completes physical Unicode path exactly once', async () => {
  const f = fixture(), h = hook(f), result = h.pick(), requestId = id(f);
  assert.equal(f.window.__dshPhoneDirectoryPicker.isPending(requestId), true);
  assert.equal(f.window.__dshPhoneDirectoryResult('unknown', '/wrong', null), false);
  assert.equal(f.window.__dshPhoneDirectoryResult(requestId, '/storage/emulated/10/项目 空格', null), true);
  assert.equal(await result, '/storage/emulated/10/项目 空格');
  assert.equal(f.window.__dshPhoneDirectoryResult(requestId, '/wrong', null), false);
  assert.equal(f.timers.size, 0); assert.equal(f.window.__dshPhoneDirectoryPicker.isPending(requestId), false);
});
test('cancel and native errors release pending slot for retry without reusing tickets', async () => {
  const f = fixture(), h = hook(f); let p = h.pick(), first = id(f);
  f.window.__dshPhoneDirectoryResult(first, null, null); assert.equal(await p, null);
  p = h.pick(); const second = id(f); assert.notEqual(first, second);
  const rejected = assert.rejects(p, /授权/); f.window.__dshPhoneDirectoryResult(second, null, '请先授权'); await rejected;
  p = h.pick(); f.window.__dshPhoneDirectoryResult(id(f), '/storage/ABCD-1234/work', null); assert.equal(await p, '/storage/ABCD-1234/work');
});
test('one pending promise bounds overlapping clicks and duplicate injection preserves its owner', async () => {
  const f = fixture(), h = hook(f), p = h.pick(), requestId = id(f);
  f.install(); assert.equal(h, hook(f)); assert.equal(f.window.__dshPhoneDirectoryPicker.isPending(requestId), true);
  await assert.rejects(h.pick(), /完成/); assert.equal(f.links.length, 1);
  f.window.__dshPhoneDirectoryResult(requestId, null, null); await p;
});
test('invalid paths and malformed error payloads are not adopted as workspace paths', async () => {
  const f = fixture(), h = hook(f);
  for (const value of ['content://cloud/tree/a', 'relative', '/a/../b', '/a\u0000b', '/a//b']) {
    const p = h.pick(), rejected = assert.rejects(p, /路径/); f.window.__dshPhoneDirectoryResult(id(f), value, null); await rejected;
  }
  const p = h.pick(), rejected = assert.rejects(p, /失败/); f.window.__dshPhoneDirectoryResult(id(f), null, { unknown: true }); await rejected;
});
test('timeout and explicit cancellation notify native with matching ticket and ignore late results', async () => {
  const f = fixture(), h = hook(f), first = h.pick(), old = id(f), rejected = assert.rejects(first, /超时/);
  f.expire(); await rejected;
  assert.equal(new URL(f.links.at(-1)).pathname, '/cancel'); assert.equal(new URL(f.links.at(-1)).searchParams.get('id'), old);
  assert.equal(f.window.__dshPhoneDirectoryResult(old, '/late', null), false);
  const next = h.pick(), current = id(f); h.cancel(); assert.equal(await next, null);
  assert.equal(new URL(f.links.at(-1)).searchParams.get('id'), current); assert.equal(f.timers.size, 0);
});
test('pagehide clears pending without hijacking navigation and later page can select again', async () => {
  const f = fixture(), h = hook(f), p = h.pick(); const links = f.links.length;
  f.event('pagehide'); assert.equal(await p, null); assert.equal(f.timers.size, 0); assert.equal(f.links.length, links);
  const next = h.pick(); f.window.__dshPhoneDirectoryResult(id(f), null, null); await next;
});
test('missing secure randomness and navigation failure are explicit retryable errors', async () => {
  const missing = fixture(undefined, { crypto: {} }); await assert.rejects(hook(missing).pick(), /安全|随机/); assert.equal(missing.links.length, 0);
  const f = fixture(), h = hook(f); f.setFailure(true); await assert.rejects(h.pick(), /打开|选择/); assert.equal(f.timers.size, 0);
  f.setFailure(false); const next = h.pick(); f.window.__dshPhoneDirectoryResult(id(f), null, null); await next;
});
test('changed origin cannot launch or adopt a delayed result from previous page', async () => {
  const f = fixture(), h = hook(f), old = h.pick(), requestId = id(f);
  f.navigate('https://example.org/'); f.window.__dshPhoneDirectoryResult(requestId, '/wrong-origin', null); assert.equal(await old, null);
  await assert.rejects(h.pick(), /页面/); assert.equal(f.links.length, 1);
});

test('actual React chooser preserves original browse, callbacks, locale, cancellation and form behavior', { timeout: 90_000 }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.DSH_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
  const dist = path.join(root, 'runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist');
  const files = await import('node:fs/promises').then(fs => fs.readdir(path.join(dist, 'assets')));
  const {shared} = await frontendShared(dist);
  const styles = files.filter(x=>x.endsWith('.css')).map(x=>'<link rel="stylesheet" href="/assets/'+x+'">').join('');
  assert.equal(overlaySource.split('return module.exports;').length, 2);
  const exposed = overlaySource.replace('return module.exports;', 'module.exports.test = { BrowseDirectoryFlow }; return module.exports;');
  const harness = `import '/assets/shared.js';
const shared=window.__TEST_SHARED__, React=shared.react, createRoot=shared['react-dom/client'].createRoot;
window.__ModuleLoader__={load({id,factory}){window.plugin=factory(name=>{if(!(name in shared))throw Error('actual shared dependency absent '+name);return shared[name];});}};
${exposed}
window.locale='zh';window.dicts={};window.calls=[];window.lists=[];window.creates=[];window.nativePicks=0;window.nativeCancels=0;window.open=true;window.busy=false;
window.plugin.apply({effect:fn=>fn(),locale:{register:(ns,locale,dict)=>{window.dicts[locale]=dict;return()=>{};},bind:()=>key=>window.dicts[window.locale][key]??key},uiWorkspace:{},slots:{inject:(name,fn)=>{const value=fn();if(value&&typeof value.next==='function')for(const ignored of value){};return()=>{};},register:()=>()=>{}}});
window.bridge=()=>{window.__DSH_DIRECTORY_PICKER__={pick(){window.nativePicks++;return new Promise((resolve,reject)=>{window.nativeResolve=resolve;window.nativeReject=reject;});},cancel(){window.nativeCancels++;window.nativeResolve?.(null);}};};
window.dropBridge=()=>{delete window.__DSH_DIRECTORY_PICKER__;};
const listDirectory=async p=>{window.lists.push(p??'HOME');const target=p??'/fixture';return {path:target,home:'/fixture',crumbs:[{name:'fixture',path:'/fixture',hidden:false}],entries:target==='/fixture'?[{name:'existing',path:'/fixture/existing',hidden:false}]:[],truncated:false};};
const createDirectory=async(p,name)=>{window.creates.push({p,name});return p+'/'+name;};
const view=createRoot(document.getElementById('app'));function App(){React.useLayoutEffect(()=>{window.mounted=true;});return React.createElement(window.plugin.test.BrowseDirectoryFlow,{open:window.open,busy:window.busy,listDirectory,createDirectory,t:key=>window.dicts[window.locale][key]??key,onPicked:path=>{window.calls.push({kind:'picked',path});},onCancel:()=>{window.calls.push({kind:'cancel'});},onError:message=>{window.calls.push({kind:'error',message});}});}
window.render=()=>view.render(React.createElement(App));window.unmount=()=>view.unmount();window.render();`;
  const browser = await chromium.launch({ headless: true }); const cases = [];
  async function open({ native = true, locale = 'zh', width = 393 } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(5000);
    await page.route('**/*', async route => { const p = new URL(route.request().url()).pathname;
      if (p === '/assets/shared.js') return route.fulfill({ contentType: 'text/javascript', body: shared });
      if (p === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: harness });
      if (p.startsWith('/assets/')) return route.fulfill({contentType:p.endsWith('.css')?'text/css':'text/javascript',body:await readFile(path.join(dist,p))});
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+styles+'<form id="form"><div id="app"></div></form><script>window.submits=0;form.onsubmit=e=>{e.preventDefault();submits++;}</script><script type="module" src="/fixture.js"></script>' });
    });
    await page.goto('http://127.0.0.1:3080/'); await page.waitForFunction(() => window.mounted, null, {timeout:5000}).catch(error=>{throw Error('actual React fixture did not mount: '+errors.join('; ')+' '+error.message);});
    await page.evaluate(({ native, locale }) => { window.open=false;window.render();window.locale=locale;if(native)window.bridge(); }, { native, locale });
    await page.waitForTimeout(30); await page.evaluate(() => { window.open=true;window.render(); }); await page.waitForTimeout(30);
    return { context, page, errors };
  }
  try {
    for (const locale of ['zh','en']) {
      const { context, page, errors } = await open({ locale });
      const system = locale==='zh'?'系统文件夹选择':'System folder picker', browse = locale==='zh'?'内置目录浏览':'Browse directories', cancel = locale==='zh'?'取消':'Cancel';
      assert.equal(await page.getByRole('button',{name:system,exact:true}).count(),1,'native system choice must be offered alongside old browse flow');
      assert.equal(await page.getByRole('button',{name:browse,exact:true}).count(),1);
      await page.getByRole('button',{name:system,exact:true}).dblclick(); assert.equal(await page.evaluate(()=>window.nativePicks),1);
      await page.evaluate(()=>window.nativeResolve('/storage/emulated/0/文档 空格'));
      await page.waitForFunction(()=>window.calls.some(x=>x.kind==='picked'));
      assert.deepEqual(await page.evaluate(()=>window.calls),[{kind:'picked',path:'/storage/emulated/0/文档 空格'}]);
      assert.equal(await page.evaluate(()=>window.submits),0); assert.deepEqual(errors,[]);
      cases.push({case:'actual native choice/result/double-click/locale/form',locale,pass:true}); await context.close();
    }
    {
      const {context,page,errors}=await open();await page.getByRole('button',{name:'内置目录浏览',exact:true}).click();
      await page.getByRole('button',{name:'existing',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'新建文件夹',exact:true}).count(),1);
      await page.getByRole('button',{name:'existing',exact:true}).click();await page.getByRole('button',{name:'打开',exact:true}).click();
      await page.waitForFunction(()=>window.calls.some(x=>x.kind==='picked'));assert.deepEqual(await page.evaluate(()=>window.calls),[{kind:'picked',path:'/fixture/existing'}]);
      assert.equal(await page.evaluate(()=>window.nativePicks),0);assert.deepEqual(errors,[]);cases.push({case:'actual existing browse listing and selected path preserved',pass:true});await context.close();
    }
    {
      const {context,page,errors}=await open();await page.getByRole('button',{name:'内置目录浏览',exact:true}).click();
      await page.getByRole('button',{name:'existing',exact:true}).waitFor();await page.getByRole('button',{name:'新建文件夹',exact:true}).click();
      await page.getByRole('textbox',{name:'文件夹名称',exact:true}).fill('新建 中文目录');await page.getByRole('button',{name:'创建',exact:true}).click();
      await page.waitForFunction(()=>window.creates.length===1);assert.deepEqual(await page.evaluate(()=>window.creates),[{p:'/fixture',name:'新建 中文目录'}]);
      await page.getByRole('button',{name:'打开',exact:true}).click();await page.waitForFunction(()=>window.calls.length===1);
      assert.deepEqual(await page.evaluate(()=>window.calls),[{kind:'picked',path:'/fixture/新建 中文目录'}]);assert.deepEqual(errors,[]);
      cases.push({case:'existing browse create-directory contract retained',pass:true});await context.close();
    }
    {
      const {context,page,errors}=await open();await page.getByRole('button',{name:'内置目录浏览',exact:true}).click();
      await page.getByRole('button',{name:'existing',exact:true}).waitFor();await page.getByRole('button',{name:'编辑路径',exact:true}).click();
      const input=page.getByRole('textbox',{name:'编辑路径',exact:true});await input.fill('/fixture/手动路径');await input.press('Enter');
      await page.waitForFunction(()=>window.lists.includes('/fixture/手动路径'));await page.getByRole('button',{name:'打开',exact:true}).click();
      await page.waitForFunction(()=>window.calls.length===1);assert.deepEqual(await page.evaluate(()=>window.calls),[{kind:'picked',path:'/fixture/手动路径'}]);assert.deepEqual(errors,[]);
      cases.push({case:'existing browse manual path entry contract retained',pass:true});await context.close();
    }
    {
      const {context,page,errors}=await open({native:false,width:900});await page.getByRole('button',{name:'existing',exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'系统文件夹选择',exact:true}).count(),0);await page.getByRole('button',{name:'取消',exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>window.calls),[{kind:'cancel'}]);assert.deepEqual(errors,[]);cases.push({case:'no bridge retains old browse interaction exactly',pass:true});await context.close();
    }
    {
      const {context,page,errors}=await open();await page.getByRole('button',{name:'系统文件夹选择',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).dblclick();
      await page.waitForTimeout(20);assert.deepEqual(await page.evaluate(()=>window.calls),[{kind:'cancel'}]);assert.equal(await page.evaluate(()=>window.nativeCancels),1);
      await page.evaluate(()=>window.nativeResolve('/late'));await page.waitForTimeout(20);assert.equal(await page.evaluate(()=>window.calls.length),1);assert.deepEqual(errors,[]);
      cases.push({case:'native cancel once, late result ignored',pass:true});await context.close();
    }
    {
      const {context,page,errors}=await open();await page.getByRole('button',{name:'系统文件夹选择',exact:true}).click();await page.evaluate(()=>window.nativeReject(Error('fixture native unavailable')));
      await page.waitForFunction(()=>window.calls.some(x=>x.kind==='error'));assert.equal(await page.evaluate(()=>window.calls[0].message),'fixture native unavailable');
      await page.getByRole('button',{name:'内置目录浏览',exact:true}).click();await page.getByRole('button',{name:'existing',exact:true}).waitFor();assert.deepEqual(errors,[]);
      cases.push({case:'native failure reports original owner error and allows old browse retry',pass:true});await context.close();
    }
    for(const unmount of [false,true]){
      const {context,page,errors}=await open();await page.getByRole('button',{name:'系统文件夹选择',exact:true}).click();
      await page.evaluate(unmount=>{if(unmount)window.unmount();else{window.open=false;window.render();}},unmount);await page.waitForTimeout(30);
      await page.evaluate(()=>window.nativeResolve('/late'));await page.waitForTimeout(30);assert.deepEqual(await page.evaluate(()=>window.calls),[]);assert.equal(await page.evaluate(()=>window.nativeCancels),1);assert.deepEqual(errors,[]);
      cases.push({case:unmount?'unmount cancels native and ignores result':'withdrawn open cancels native and ignores result',pass:true});await context.close();
    }
    await writeFile(path.join(report,'react-browser-results.json'),JSON.stringify({browser:browser.version(),cases},null,2)+'\n');
  } finally { await writeFile(path.join(report,'react-browser-partial.json'),JSON.stringify({browser:browser.version(),cases},null,2)+'\n'); await browser.close(); }
});
