import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import os from 'node:os';
import {createServer} from 'node:http';
import {apply} from './index.mjs';
import {patchOpenCode} from './compat/opencode.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),runtime=path.join(root,root.includes('dsh-phone-public')?'runtime':'desktop-runtime');
const report=process.argv[2]||path.join(os.tmpdir(),'dsh-appearance-ui');await mkdir(report,{recursive:true});
const {chromium}=await import(pathToFileURL(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
const dist=path.join(runtime,'node_modules/@deepseek-ai/dsh-web-frontend/dist'),frontend=await readFile(path.join(dist,'assets/index-DjTxlw_T.js'),'utf8');
const boot=frontend.indexOf('const fo=globalThis.dshDesktopBoot');assert(boot>0);
const shared=frontend.slice(0,boot)+'window.__TEST_SHARED__=lM();\n';
const nativeTheme=await readFile(path.join(runtime,'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),'utf8');
const slotCore=await readFile(path.join(runtime,'node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js'),'utf8');
const client=await readFile(path.join(root,'appearance/client.js'),'utf8');
const paletteClient=patchOpenCode(await readFile(path.join(root,'appearance/test-fixtures/opencode-2.0.26.js'),'utf8'));
const legacyCss=await readFile(path.join(root,'peer/workflow-hub/theme.css'),'utf8');
const phone=root.includes('dsh-phone-public');
const phoneCss=phone?await readFile(path.join(root,'app/src/main/assets/dsh-phone.css'),'utf8'):'';
const phoneJs=phone?await readFile(path.join(root,'app/src/main/assets/dsh-phone.js'),'utf8'):'';
const peer=await readFile(path.join(root,'peer/agent-cards/client-source.js'),'utf8'),legacyAdapter=peer.slice(peer.indexOf('function registerLegacyAppearance'),peer.indexOf('/** React 18'));
const home=await mkdtemp(path.join(os.tmpdir(),'dsh-appearance-ui-home-'));process.env.DSH_HOME=home;
await mkdir(path.join(home,'appearance'));await writeFile(path.join(home,'appearance/theme.json'),' {"skin":"mint","revision":9}\n');
const routes=new Map();let manage,deny=false,missing=false;
await apply({clientModules:{clientPath:()=>undefined,onGraphChanged:()=>()=>{}},connection:{rpc:{handle:(route,handler)=>{manage=handler;}}},webServer:{register:route=>{routes.set(route.path,route.handler);return()=>routes.delete(route.path);}},effect:f=>f()});
const fixture=`import '/assets/test-shared.js';import {SlotCore} from '/slots.js';
const shared=window.__TEST_SHARED__,React=shared.react;
let Native;window.__ModuleLoader__={load:({factory})=>{Native=factory(id=>shared[id]);}};
${nativeTheme}
const effects=[],listeners=new Map(),calls=[];
const ctx={effect(fn){const dispose=fn();if(typeof dispose==='function')effects.push(dispose);},on(event,fn){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(fn);return()=>listeners.get(event).delete(fn);},emit(event,value){for(const fn of listeners.get(event)||[])fn(value);}};
const host={getSnapshot:()=>({value:{preference:'system',fontSize:14}}),subscribe:()=>()=>{},set(key,value){calls.push({key,value});}};
const theme=new Native.ThemeRuntime(ctx,host);ctx.theme=theme;
const slots=new SlotCore();slots.register({name:'root',children:{'settings.section':{kind:'list'},'settings.general.item':{kind:'list'},'settings.plugins.tab':{kind:'list'}}},()=>null);
const original=()=>React.createElement('div',null,'旧外观入口');
slots.register({name:'settings.general.item',id:'appearance'},original);slots.register({name:'settings.general.item',id:'font-size'},original);
const mount=shared['react-dom/client'].createRoot(document.getElementById('settings'));
const render=()=>{const entry=slots.entriesOfSlot('settings.section').find(e=>e.options.id==='appearance');mount.render(React.createElement(entry.component));};
ctx.slots={inject:(name,fn)=>{const dispose=fn();if(typeof dispose==='function')effects.push(dispose);return dispose;},entriesOfSlot:key=>slots.entriesOfSlot(key),register:(options,component)=>{const dispose=slots.register(options,component);render();effects.push(dispose);return dispose;}};
slots.onMutate(key=>ctx.emit('slots/changed',key));
${legacyAdapter}
registerLegacyAppearance(ctx,{name:'settings.section',id:'appearance',label:'外观皮肤'},original);
ctx.on('theme/change',snapshot=>{const body=document.body;for(const key of Object.keys(body.style)){};for(const key of Array.from(body.style))if(key.startsWith('--dsw-'))body.style.removeProperty(key);for(const [key,value] of Object.entries(snapshot.active.tokens))body.style.setProperty(key,value);body.toggleAttribute('data-ds-dark-theme',snapshot.active.colorScheme==='dark');});
let legacy;const legacyEffects=[];
window.__ModuleLoader__={load:({factory})=>{legacy=factory(id=>shared[id]);}};
${paletteClient}
const legacySlots={...ctx.slots,inject:(name,fn)=>{const dispose=fn();if(typeof dispose==='function')legacyEffects.push(dispose);return dispose;},register:(options,component)=>{const dispose=slots.register(options,component);legacyEffects.push(dispose);return dispose;}};
const legacyCtx={...ctx,effect(fn){const dispose=fn();if(typeof dispose==='function')legacyEffects.push(dispose);},get:name=>({theme,slots:legacySlots})[name]};
legacy.apply(legacyCtx);const legacyBefore=JSON.stringify(window.__opencodePalette.getState());
window.__ModuleLoader__={load:({factory})=>{window.plugin=factory();}};
${client}
await window.plugin.apply(ctx);render();window.fixture={theme,slots,calls,legacyBefore,dispose(){for(const fn of effects.reverse())fn();}};window.ready=true;
`;
const server=createServer(async(req,res)=>{
 const route=new URL(req.url,'http://fixture').pathname;
 if(route==='/appearance-center/manage'){let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);const result=deny&&request.payload.action!=='status'?{ok:false,error:{message:'fixture disk full'}}:await manage(request.method,request.payload);res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({type:'server-response',rpcId:request.rpcId,result}));return;}
 if(missing&&route.includes('/themes/dream--abyss')){res.writeHead(503).end();return;}
 if(routes.has(route)){await routes.get(route)(req,res);return;}
 const assets={'/assets/test-shared.js':shared,'/slots.js':slotCore,'/fixture.js':fixture,'/legacy.css':legacyCss,'/phone.css':phoneCss,'/phone.js':phoneJs};
 if(route in assets){res.writeHead(200,{'content-type':route.endsWith('.css')?'text/css':'text/javascript'}).end(assets[route]);return;}
 if(route.startsWith('/assets/')){try{res.writeHead(200,{'content-type':route.endsWith('.css')?'text/css':'text/javascript'}).end(await readFile(path.join(dist,route)));}catch{res.writeHead(404).end();}return;}
 if(route==='/other'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<!doctype html><html data-dsh-skin="mint"><link rel="stylesheet" href="/legacy.css"><body><p>保留的插件设置</p></body></html>');return;}
 res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<!doctype html><html data-dsh-skin="mint"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/legacy.css"><link rel="stylesheet" href="/assets/index-DBK_Mahs.css">'+(phone?'<link rel="stylesheet" href="/phone.css"><script defer src="/phone.js"></script>':'')+'<style>body{margin:0}#settings{width:min(100%,980px);margin:auto}.wSkVaW_root{min-height:100vh}#other{display:none}</style><body><div class="wSkVaW_root"><input id="draft" value="保留未发送的草稿"><pre><code>const answer = 42;</code></pre><div id="settings" class="VOzbGW_options"></div><iframe id="other" src="/other"></iframe></div><script type="module" src="/fixture.js"></script></body></html>');
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port;const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const results=[],errors=[];
try{
 for(const viewport of [{width:1280,height:900},{width:393,height:852},{width:320,height:640},{width:800,height:1280}]){
  const context=await browser.newContext({viewport,hasTouch:viewport.width<900,isMobile:viewport.width<600});const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>{errors.push(e.message);console.error('Fixture:',e.message);});
  page.on('requestfailed',request=>console.error('Request:',request.url(),request.failure()?.errorText));page.on('console',msg=>{if(msg.type()==='error')console.error('Console:',msg.text());});
  await page.goto(url);try{await page.waitForFunction(()=>window.ready,{},{timeout:22000});}catch(error){console.error('Diagnostics:',await page.evaluate(()=>({links:[...document.querySelectorAll('link')].map(l=>({href:l.href,sheet:!!l.sheet,media:l.media})),script:[...document.scripts].map(s=>s.src),text:document.body.innerText,plugin:!!window.plugin})));throw error;}const frame=page.frameLocator('iframe[title="统一外观设置"]');await frame.locator('details').first().waitFor();
  assert.equal(await frame.locator('details').count(),7);
  assert.equal(await page.locator('style[data-plugin="dsh-opencode-palette"]').count(),0);assert.equal(await page.evaluate(()=>JSON.stringify(window.__opencodePalette.getState())===window.fixture.legacyBefore),true);
  assert.equal(await page.evaluate(()=>window.fixture.slots.entries('settings.section').filter(e=>e.options.id==='opencode-palette').length),0);
  assert.equal(await page.evaluate(()=>window.fixture.slots.entries('settings.section').filter(e=>e.options.id==='appearance').length),1);
  await frame.locator('#notice').filter({hasText:'已加载 7 个来源，共 224 套主题'}).waitFor();
  const choose=async(id)=>{await frame.getByRole('searchbox').fill(id);await frame.locator('[data-theme="'+id+'"]').click();await frame.locator('[data-theme="'+id+'"][aria-pressed=true]').waitFor();await frame.locator('#notice').filter({hasText:'外观已应用并保存'}).waitFor();await page.waitForFunction(id=>document.body.dataset.appearanceCenter!==undefined && window.fixture.theme.getTheme().active.tokens && document.querySelector('link[href$="'+id.replace(':','--')+'.css"][media=all]'),id);};
  for(const id of ['opencode:tokyonight','dream:abyss','beizi:nord','oil:proof','gallery:catppuccin','tweaks:spec-sheet','local:mint']){
   await choose(id);assert.equal(await page.locator('#draft').inputValue(),'保留未发送的草稿');
   assert.equal(await page.locator('link[href*="/themes/"][media=all]').count(),1);
   const overflow=await frame.locator('body').evaluate(el=>el.scrollWidth>document.documentElement.clientWidth+1);assert.equal(overflow,false,id+' overflow '+viewport.width);
  }
  await frame.locator('select[name=codeFont]').selectOption('jetbrains');await frame.locator('select[name=codeSize]').selectOption('16');await frame.getByRole('button',{name:'保存调整',exact:true}).click();await frame.locator('#notice').filter({hasText:'外观已应用并保存'}).waitFor();
  assert.equal(await page.locator('pre code').evaluate(el=>getComputedStyle(el).fontSize),'16px');assert((await page.locator('pre code').evaluate(el=>getComputedStyle(el).fontFamily)).includes('JetBrains Mono'));
  await frame.getByRole('searchbox').fill('');await frame.locator('select[name=mode]').selectOption('dark');await frame.getByRole('button',{name:'保存调整',exact:true}).click();await page.waitForFunction(()=>window.fixture.theme.getTheme().active.colorScheme==='dark');
  await page.reload();await page.waitForFunction(()=>window.ready);assert.equal(await page.evaluate(()=>window.fixture.theme.getTheme().active.colorScheme),'dark');
  const currentFrame=page.frameLocator('iframe[title="统一外观设置"]');await currentFrame.getByRole('button',{name:'恢复原版',exact:true}).click();await currentFrame.locator('[data-theme="local:original"][aria-pressed=true]').waitFor();await currentFrame.locator('#notice').filter({hasText:'外观已应用并保存'}).waitFor();assert.equal(await page.locator('html').getAttribute('data-dsh-skin'),null);assert.equal(await page.locator('body').getAttribute('data-dsh-catppuccin'),null);
  // Late legacy fetches cannot overwrite the unified selection.
  await page.evaluate(()=>document.documentElement.dataset.dshSkin='mint');await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-dsh-skin'));
  await currentFrame.getByRole('searchbox').fill('dream:abyss');missing=true;await currentFrame.locator('[data-theme="dream:abyss"]').click();await currentFrame.locator('#notice[data-error]').waitFor();assert.equal(await currentFrame.locator('#current-name').textContent(),'原版');missing=false;
  deny=true;await currentFrame.locator('[data-theme="dream:abyss"]').click();await currentFrame.locator('#notice').filter({hasText:'disk full'}).waitFor();assert.equal(await currentFrame.locator('#current-name').textContent(),'原版');deny=false;
  await currentFrame.getByRole('searchbox').fill('local:mint');await currentFrame.locator('[data-theme="local:mint"]').click();await currentFrame.locator('[data-theme="local:mint"][aria-pressed=true]').waitFor();await currentFrame.getByRole('searchbox').fill('');
  await currentFrame.locator('#notice').filter({hasText:'外观已应用并保存'}).waitFor();
  await page.evaluate(()=>window.__opencodePalette.setTheme('dracula'));assert.equal(await page.locator('style[data-plugin="dsh-opencode-palette"]').count(),0);
  await page.screenshot({path:path.join(report,'appearance-'+viewport.width+'.png'),fullPage:true});
  await page.evaluate(()=>window.fixture.dispose());assert.equal(await page.locator('style[data-plugin="dsh-opencode-palette"]').count(),1);assert.equal(await page.evaluate(()=>window.__opencodePalette.getState().theme),'dracula');assert.equal(await page.evaluate(()=>window.fixture.slots.entries('settings.section').filter(e=>e.options.id==='opencode-palette').length),1);
  results.push({width:viewport.width,providerSwitches:7,draftPreserved:true,noStyleAccumulation:true,noOverflow:true,saveReload:true,restoreOriginal:true,lateLegacyIgnored:true,missingAssetRecovery:true,writeFailureRecovery:true});await context.close();
 }
 assert.deepEqual(errors,[]);
 await writeFile(path.join(report,'verification.json'),JSON.stringify({sdk:'0.2.1-alpha.1',actualThemeRuntime:true,actualSlotCore:true,pinnedReact:true,phonePresentation:phone,realComputedCodeFontAndSize:true,realLegacyOpenCode:true,legacySettingsPreserved:true,legacyRendererSuspended:true,legacyRendererAndNavigationRestored:true,results,pageErrors:errors},null,2));console.log(JSON.stringify({results,pageErrors:errors}));
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true});}
