import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { ControlledMarket } from '../peer/controlled-market/catalog.mjs';
import { AgentCards } from '../peer/agent-cards/store.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] ?? path.join(os.tmpdir(), 'dsh-settings-embed-ui');
await fs.mkdir(out, { recursive: true });
const read = n => fs.readFile(path.join(root, n), 'utf8');
const require = createRequire(path.join(root, 'vendor/dsh-codearts-auth/package.json'));
const { build } = require('esbuild');
const { chromium } = await import(pathToFileURL(process.env.DSH_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
const sdk = (await read('runtime/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js')).replace('exports.SettingsDocumentStore =', 'exports.SettingsPanel = SettingsPanel; exports.SettingsDocumentStore =');
const bundle = async client => (await build({ stdin: { resolveDir: path.join(root, 'vendor/dsh-codearts-auth'), contents: `
import React from 'react'; import * as jsx from 'react/jsx-runtime'; import * as ReactDOM from 'react-dom'; import {createRoot} from 'react-dom/client';
let sdk, plugin;
const icon=()=>React.createElement('span');
window.__ModuleLoader__={load:({id,factory})=>{const result=factory(name=>name==='react'?React:name==='react/jsx-runtime'?jsx:name==='react-dom'?ReactDOM:name==='@deepseek-ai/dsh-client-ui-primitives'?new Proxy({useModalLayer(){}},{get:(t,k)=>t[k]??icon}):{});if(id==='dsh-phone-qq')plugin=result;else sdk=result;}};
${sdk}
${client}
const rows=[],disposers=[];
plugin.apply({on:()=>()=>{},slots:{entriesOfSlot:()=>rows.map(r=>({options:r})),inject:(key,fn)=>{const off=fn();if(off)disposers.push(off);},register:(options,render)=>{rows.push({...options,render});return()=>{};}}});
let open=true,select;const app=createRoot(document.getElementById('app'));
function App(){const [active,setActive]=React.useState('controlled-plugin-market');select=setActive;return open?React.createElement(sdk.SettingsPanel,{rows,activeId:active,onSelect:setActive,onClose:()=>{open=false;app.render(React.createElement(App));},renderSlot:(slot,props,filter)=>slot==='settings.section'?rows.find(r=>r.id===filter.only).render():slot==='settings.header'?'设置':slot==='settings.close'?'关闭':null}):null;}
window.selectSettings=id=>select(id);window.closeSettings=()=>{open=false;app.render(React.createElement(App));};app.render(React.createElement(App));
` }, bundle:true,format:'iife',platform:'browser',target:'chrome80',write:false })).outputFiles[0].text;
const current = await bundle(await read('phone-qq/cards-client.js'));
const nativeFallback = await read('app/src/main/assets/dsh-settings-embed.js');
const legacyPath = process.env.DSH_EMBED_BEFORE_CLIENT;
// The previous iframe contract, for the APK-upgrade case even in source archives
// without Git history. A real prior bundle may also be supplied for replay.
const legacyFixture = `window.__ModuleLoader__.load({id:'dsh-phone-qq',factory:()=>({apply(ctx){
 for(const[id,label,src]of [['controlled-plugin-market','插件市场','/controlled-market'],['agent-persona-cards','Agent 人设','/agent-cards'],['phone-cloud-tools','手机工具箱','/phone-tools']])
 ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id,label},()=>({$$typeof:Symbol.for('react.element'),type:'iframe',key:null,ref:null,_owner:null,props:{title:label,src,'data-dsh-settings-embed':'',style:{width:'100%',height:'min(72dvh, 760px)',minHeight:320,border:0,display:'block'}}})));
}})});`;
const legacy = await bundle(legacyPath ? await fs.readFile(legacyPath,'utf8') : legacyFixture);
const storage = new Map(), cards = new AgentCards({get:async k=>storage.get(k),set:async(k,v)=>storage.set(k,v)});await cards.init();
const market=new ControlledMarket({role:'phone',home:path.join(out,'market'),fetchImpl:async()=>new Response(JSON.stringify({plugins:Array.from({length:5},(_,i)=>({name:i===0?'Noema':'测试插件 '+i,owner:'fixture',url:'https://github.com/example/plugin-'+i,description:{zh:'测试窄屏设置的内容高度与滚动；这不是已安装插件。'},stars:10-i,version:'1.0.0'}))}))});
const browser=await chromium.launch({headless:true,...(process.env.DSH_CHROME?{executablePath:process.env.DSH_CHROME}:{})});
const result={browser:browser.version(),cases:[],errors:[],unexpectedNetwork:[],actualSdkSettingsPanel:true,modelRequests:0};
async function open({width=393,height=852,legacy=false,oldCss=false,noObservers=false,native=false}={}){
 const context=await browser.newContext({viewport:{width,height}}),page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message));
 await context.addInitScript(noObservers=>{
  window.__embedActiveObservers=0;window.__embedObserverStates=[];
  for(const name of ['ResizeObserver','MutationObserver']){
   const Original=window[name];if(!Original)continue;
   window[name]=class extends Original {
    observe(...args){if(!this.active){this.active=true;window.__embedActiveObservers++;if(!this.debug){this.debug={name,active:true,stack:new Error().stack};window.__embedObserverStates.push(this.debug);}this.debug.active=true;}return super.observe(...args);}
    disconnect(){if(this.active){this.active=false;window.__embedActiveObservers--;this.debug.active=false;}super.disconnect();}
   };
  }
  if(noObservers){window.ResizeObserver=undefined;window.structuredClone=undefined;}
 },noObservers);
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url()),p=url.pathname;
  if(!['127.0.0.1','localhost'].includes(url.hostname)){result.unexpectedNetwork.push(url.origin);return route.abort();}
  if(p==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:system-ui;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#fff}body{margin:0}</style><div id="app"></div><script src="/fixture.js"></script>'});
  if(p==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:legacy?await fs.readFile(path.join(out,'legacy.js'),'utf8'):current});
  if(p==='/appearance/theme-client.js')return route.fulfill({contentType:'text/javascript',body:''});
  if(p==='/foreign')return route.fulfill({contentType:'text/html',body:'<!doctype html><h1>Other origin</h1>'});
  if(p==='/controlled-market/manage'||p==='/agent-cards/manage'||p==='/plugin-center/manage'){
   const payload=route.request().postDataJSON().payload;
   const value=p==='/controlled-market/manage'?await market.manage(payload):p==='/plugin-center/manage'?{bundles:[]}:payload.action==='status'?await cards.status():await cards.change(payload.action,payload);
   return route.fulfill({json:{result:{ok:true,value}}});
  }
  for(const[base,dir]of[['/controlled-market','peer/controlled-market'],['/agent-cards','peer/agent-cards']])if(p===base||p.startsWith(base+'/page.')){
   const file=p===base?'page.html':path.basename(p);return route.fulfill({contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html',body:await read(dir+'/'+file)});
  }
  if(p==='/phone-tools'||p==='/hermes-remote')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><style>body{margin:8px}button{height:44px}</style><h1>短设置页</h1><button id="end">末尾按钮</button>'});
  return route.fulfill({status:404,body:'fixture not found'});
 });
 await page.goto('http://127.0.0.1:32185/');if(!result.features)result.features=await page.evaluate(()=>({structuredClone:typeof structuredClone==='function',min:CSS.supports('height','min(72vh,760px)'),dvh:CSS.supports('height','72dvh')}));await page.locator('iframe[title="插件市场"]').waitFor();await page.frameLocator('iframe[title="插件市场"]').locator('#meta').filter({hasText:'5 个结果'}).waitFor();
 if(native){await page.addScriptTag({content:nativeFallback});await page.addScriptTag({content:nativeFallback});}
 if(oldCss||legacy)await page.addStyleTag({content:'@media(max-width:700px){.VOzbGW_panel{height:calc(100vh - 20px)!important;max-width:100%;width:100%;flex-direction:column}.VOzbGW_nav{width:100%;gap:4px;padding:8px}.VOzbGW_navList{flex-direction:row;overflow:auto}.VOzbGW_navCell{flex:none}.VOzbGW_header{height:30px;padding:0}.VOzbGW_options{padding:12px}.VOzbGW_options iframe[data-dsh-settings-embed]{height:560px!important;min-height:100%!important}}'});
 await page.waitForTimeout(100);return{page,context};
}
async function metrics(page){return page.evaluate(()=>{
 const f=document.querySelector('.VOzbGW_options iframe'),o=f.closest('.VOzbGW_options'),b=f.contentDocument.body,r=f.getBoundingClientRect(),br=b.getBoundingClientRect(),s=f.contentWindow.getComputedStyle(b),natural=br.height+(parseFloat(s.marginTop)||0)+(parseFloat(s.marginBottom)||0);
 return{height:r.height,natural,blankInside:Math.max(0,r.height-natural),innerScrollY:f.contentWindow.scrollY,outerHeight:o.clientHeight,outerScrollHeight:o.scrollHeight,blankBelow:Math.max(0,o.getBoundingClientRect().bottom-r.bottom-(parseFloat(getComputedStyle(o).paddingBottom)||0)),panelTop:f.closest('.VOzbGW_panel').getBoundingClientRect().top,horizontalOverflow:document.documentElement.scrollWidth>innerWidth,pixelHeight:f.style.height,minHeight:getComputedStyle(f).minHeight,layoutBundled:!!document.getElementById('dsh-settings-embed-layout')};
});}
try{
 if(legacy){await fs.writeFile(path.join(out,'legacy.js'),legacy);const item=await open({legacy:true});await item.page.evaluate(()=>window.selectSettings('phone-cloud-tools'));await item.page.frameLocator('iframe').locator('#end').waitFor();const m=await metrics(item.page);assert.ok(m.blankInside>50);result.legacy=m;await item.page.screenshot({path:path.join(out,'before.png')});await item.context.close();}
 for(const config of [{width:320,noObservers:true},{width:393},{width:430},{width:393,noExternalPresentation:true},{width:393,legacy:true,native:true}]){
  const {width}=config;
  const item=await open({...config,oldCss:!config.noExternalPresentation}),{page}=item;
  const frame=page.frameLocator('iframe[title="插件市场"]');let m=await metrics(page);assert.ok(m.blankInside<3);assert.ok(m.height>m.outerHeight,'long document must expand and use the outer settings scroller');assert.equal(m.horizontalOverflow,false);const long=m.height;
  await frame.locator('#query').fill('Noema');await frame.locator('#meta').filter({hasText:'1 个结果'}).waitFor();await page.waitForTimeout(120);m=await metrics(page);assert.ok(m.height<long);assert.ok(m.blankInside<3);
  await frame.locator('#query').fill('不存在');await frame.locator('#meta').filter({hasText:'0 个结果'}).waitFor();await page.waitForTimeout(120);m=await metrics(page);assert.ok(m.blankInside<3);assert.equal(m.minHeight,'0px');
  await page.evaluate(()=>window.selectSettings('phone-cloud-tools'));await page.frameLocator('iframe').locator('#end').waitFor();await page.waitForTimeout(100);const short=await metrics(page);assert.ok(short.height<320);assert.ok(short.blankInside<3);assert.ok(short.blankBelow<3);assert.equal(short.panelTop,0);await page.screenshot({path:path.join(out,'short-'+width+'.png')});
  await page.locator('iframe').evaluate(f=>{f.src='http://127.0.0.1:32186/foreign';});await page.waitForTimeout(150);
  const foreign=await page.locator('iframe').evaluate(f=>({height:f.getBoundingClientRect().height,natural:f.closest('.VOzbGW_panel').hasAttribute('data-dsh-embed-natural')}));
  assert.ok(foreign.height>0&&foreign.height<=760);assert.equal(foreign.natural,false);
  await page.locator('iframe').evaluate(f=>{f.src='/phone-tools';});await page.frameLocator('iframe').locator('#end').waitFor();await page.waitForTimeout(100);assert.ok((await metrics(page)).height<320);
  await page.evaluate(()=>window.selectSettings('agent-persona-cards'));const editor=page.frameLocator('iframe');await editor.locator('#new-sub').waitFor();await editor.locator('#new-sub').click();await editor.locator('#card-content').fill('长页面仍可滚动到取消按钮');await page.setViewportSize({width,height:420});await page.waitForTimeout(120);await editor.locator('#cancel-edit').scrollIntoViewIfNeeded();
  const bottom=await page.evaluate(()=>{const f=document.querySelector('iframe'),b=f.contentDocument.querySelector('#cancel-edit').getBoundingClientRect(),r=f.getBoundingClientRect();return{bottom:r.top+b.bottom,innerScroll:f.contentWindow.scrollY};});assert.ok(bottom.bottom<=421);assert.equal(bottom.innerScroll,0);
  await page.evaluate(()=>window.closeSettings());await page.waitForTimeout(30);assert.equal(await page.locator('iframe').count(),0);
  // Playwright's own main-world InjectedScript also observes the page. Count only product observers.
  const active=await page.evaluate(()=>window.__embedObserverStates.filter(x=>x.active&&!x.stack.includes('InjectedScript')).length);assert.equal(active,config.native?1:0,'only the single page-wide native fallback observer may remain after unmount');
  result.cases.push({width,market:m,short,bottom,foreign,noResizeObserver:!!config.noObservers,noExternalPresentation:!!config.noExternalPresentation,oldClientWithNewApkFallback:!!config.native,observersAfterClose:active});await item.context.close();
 }
 const desktop=await open({width:1100,height:900});const m=await metrics(desktop.page);assert.equal(m.height,648);result.cases.push({desktop:m});await desktop.context.close();
 assert.deepEqual(result.errors,[]);assert.deepEqual(result.unexpectedNetwork,[]);result.passed=true;
}finally{await fs.writeFile(path.join(out,'settings-embed-ui.json'),JSON.stringify(result,null,2));await browser.close();}
console.log(JSON.stringify(result));
