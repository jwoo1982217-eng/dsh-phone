import {frontendShared} from './fixtures/frontend-shared.mjs';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import path from 'node:path';
import {createRequire} from 'node:module';
import os from 'node:os';
const root = fileURLToPath(new URL('../', import.meta.url));
const report = process.argv[2] ?? path.join(os.tmpdir(), 'dsh-model-picker');
await mkdir(report, {recursive:true});
const {chromium} = await import(pathToFileURL(process.env.DSH_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
const source = await readFile(path.join(root, 'runtime/overlays/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js'), 'utf8');
const tested = source.replace('return module.exports;', 'module.exports.test = {ModelSelect, pickerRows, pickerPreferences}; return module.exports;');
const runtime = path.join(root, root.includes('dsh-phone-public') ? 'runtime' : 'desktop-runtime');
// Reuse the pinned frontend's actual shared React, store and primitive bundle.
// Replace only its boot entry in this isolated copy; no server/session runs.
const dist=path.join(runtime,'node_modules/@deepseek-ai/dsh-web-frontend/dist');
const {shared:sharedFrontend,css}=await frontendShared(dist);
let js = `
const shared=window.__TEST_SHARED__, React=shared.react, jsx=shared['react/jsx-runtime'], ReactDOM=shared['react-dom'];
const {createRoot}=shared['react-dom/client'], {createSnapshotStore}=shared['@deepseek-ai/dsh-client-store'];
window.__ModuleLoader__ = {load({factory}) {window.picker = factory(id => ({
  'react':React, 'react/jsx-runtime':jsx, 'react-dom':ReactDOM,
  '@deepseek-ai/cordis':shared['@deepseek-ai/cordis'],
  '@deepseek-ai/dsh-client-store':{createSnapshotStore},
  '@deepseek-ai/dsh-client-ui-primitives':shared['@deepseek-ai/dsh-client-ui-primitives']
}[id]));}};
${tested}
const groups = Array.from({length:18}, (_,n)=>({id:'api-'+n,name:n===0?'聚合 API':n===1?'CodeBuddy (腾讯)':'来源 '+n,models:Array.from({length:40},(_,m)=>({id:m===0?'deepseek-v4-flash':m===1?'glm-5.3':'model-'+m,name:m===0?'DeepSeek V4 Flash':m===1?'GLM 5.3':m===2?'超长模型名称 ' + 'ABCDEFGHIJKLMNOP'.repeat(5):'Model '+m,...m===0?{reasoning:{defaultEffort:'high',efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]}}:{}}))}));
window.calls=[]; window.loads=0; window.reject=false; window.deferred=false;
window.store=createSnapshotStore({current:{provider:'api-1',model:'deepseek-v4-flash',reasoningEffort:'high'},groups,status:'ready',pending:null,error:null,failures:[]});
const t=(key,args={})=>({'menu.model':'模型','trigger.fallback':'请选择模型','trigger.selectAria':'请选择模型','trigger.aria':'选择模型，当前 '+args.model,'effort.providerDefault':'Default','status.loading':'正在刷新模型列表…','action.reload':'重新加载','search.clear':'清除搜索','error.action':'模型操作失败：'+args.message,'error.sessionInUse':'当前会话已被占用','warning.groupLoad':args.name+' 加载失败：'+args.message})[key]??key;
function App(){return React.createElement(window.picker.test.ModelSelect,{locked:false,available:true,directory:window.store,t,load:()=>window.loads++,select:async selection=>{
  window.calls.push(selection);
  window.store.update(s=>{s.pending=selection;s.status='selecting';});
  if(window.deferred)await new Promise(resolve=>window.resolveSelection=resolve);
  if(window.reject){window.store.update(s=>{s.pending=null;s.status='error';});return {ok:false,error:{code:'test/rejected',message:'fixture rejection'}};}
  window.store.update(s=>{s.current=selection;s.pending=null;s.status='ready';s.error=null;});return {ok:true,value:undefined};
}});}
createRoot(document.getElementById('app')).render(React.createElement(App));
`;
const {build}=createRequire(path.join(root,'vendor/dsh-codearts-auth/package.json'))('esbuild');
const resetBundle=await build({stdin:{resolveDir:path.join(root,'vendor/dsh-codearts-auth'),contents:`import{installZcodeComposerReset}from'./plugin-src/client/zcode-reset-launcher.js';import{installJetHubStyles}from'./plugin-src/client/jet-hub-styles.js';export function install(rpcCall){installJetHubStyles();return installZcodeComposerReset({rpcCall});}`},bundle:true,external:['react','react-dom/client'],format:'cjs',platform:'browser',write:false});
js+=`
(()=>{const module={exports:{}},exports=module.exports,require=id=>shared[id];${resetBundle.outputFiles[0].text}
window.resetCalls=[];window.resetMulti=false;window.resetFail=false;window.disposeReset=module.exports.install(async(method,p)=>{window.resetCalls.push({method,...p});if(method==='account.list')return{accounts:[{id:'account-a',enabled:true,nickname:'本人账号'},...(window.resetMulti?[{id:'account-b',enabled:true,nickname:'另一个账号'}]:[])]};if(method==='zcode.sources'){if(window.resetFail)throw Error('套餐读取失败验证');return{selected:'organization-flow:fixture:project',sources:[{id:'organization-flow:fixture:project',kind:'organization-flow',label:'机构流量'},{id:'individual',kind:'individual',label:'个人编程套餐'},{id:'team:fixture:project',kind:'team',label:'机构编程套餐'}]};}if(method==='zcode.resetStatus')return{availableFiveHourResets:p.sourceId.startsWith('team:')?[{expireAt:Date.now()+3600000},{expireAt:Date.now()+7200000}]:[],availableWeekResets:[],latestFiveHourResetHistory:null,latestWeekResetHistory:null,hasUnreadHistory:false};throw Error('本测试禁止消耗机会');});})();`;

const phoneCss = await readFile(path.join(root, 'app/src/main/assets/dsh-phone.css'), 'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return readFile(path.join(root,'peer/presentation.css'),'utf8');});
const phoneJs = await readFile(path.join(root, 'app/src/main/assets/dsh-phone.js'), 'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return readFile(path.join(root,'peer/presentation.js'),'utf8');});
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-module-platform:#f2f4f8;--dsw-alias-label-primary:#222;--dsw-alias-label-tertiary:#6b7280;--dsw-alias-border-l1:#dce1e8;--dsw-menu-surface-fill:#fff;--dsw-menu-backdrop-filter:none;--dsw-elevation-prominent:0 12px 40px #0003;--dsw-alias-interactive-bg-hover:#edf1f7;--dsw-alias-state-business-primary:#3267c4;--dsw-radius-lg:16px;--dsw-radius-md:8px;--dsw-radius-sm:4px}body{margin:0;font:14px system-ui;background:#fafbfc}#app{position:fixed;bottom:24px;right:24px}*{box-sizing:border-box}${css}\n${phoneCss}</style><div id="app" data-composer-card></div><script type="module">import '/assets/test-shared.js';\n${js.replaceAll('</script','<\\/script')}\n${phoneJs.replaceAll('</script','<\\/script')}</script>`;
await writeFile(path.join(report,'fixture.html'),html);
const server=createServer(async(req,res)=>{
  if(req.url==='/assets/test-shared.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(sharedFrontend);return;}
  if(/^\/assets\/[\w.-]+\.(js|css)$/.test(req.url)){
    try{const bytes=await readFile(path.join(dist,req.url.slice(1)));res.writeHead(200,{'content-type':req.url.endsWith('.js')?'text/javascript':'text/css'});res.end(bytes);return;}catch{res.writeHead(404);res.end();return;}
  }
  res.writeHead(200,{'content-type':'text/html'});res.end(html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port;
await writeFile(path.join(report,'fixture-url.txt'),url);
const browser=await chromium.launch({executablePath:process.env.DSH_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const results=[], errors=[];
try {
  for(const size of [{width:1280,height:800,touch:false},{width:393,height:852,touch:true},{width:320,height:640,touch:true},{width:844,height:390,touch:true},{width:800,height:1280,touch:true},{width:1280,height:800,touch:true}]) {
    const context=await browser.newContext({viewport:{width:size.width,height:size.height},isMobile:size.touch,hasTouch:size.touch});
    const page=await context.newPage();page.on('pageerror',error=>{errors.push(error.message);console.error('Fixture page error:',error.message);});
    page.setDefaultTimeout(10000);
    await page.goto(url);
    const open=async()=>{await page.getByRole('button',{name:/选择模型，当前/}).click();await page.getByRole('dialog',{name:'选择模型'}).waitFor();};
    const search=page.getByRole('searchbox');
    const rows=page.locator('[data-picker-model]');
    await open();assert.equal(await rows.count(),720);
    assert.equal(await page.getByRole('dialog').evaluate(el=>el.querySelector('.dsh-picker-list').scrollHeight>el.querySelector('.dsh-picker-list').clientHeight),true);
    const bounds=await page.getByRole('dialog').boundingBox();assert(bounds.x>=11 && bounds.x+bounds.width<=size.width-11 && bounds.y>=11 && bounds.y+bounds.height<=size.height-11);
    if(size.touch) assert.equal(await search.evaluate(el=>el===document.activeElement),false);
    if(size.touch&&size.width>=601) assert(Math.abs(bounds.x+(bounds.width/2)-size.width/2)<2);
    // Scroll the actual nested viewport, then the fixed header stays visible.
    const list=page.locator('.dsh-picker-list');
    await list.hover();await page.mouse.wheel(0,2000);await page.waitForFunction(()=>document.querySelector('.dsh-picker-list').scrollTop>100);
    assert.equal(await page.locator('.dsh-picker-head').isVisible(),true);assert.equal(await search.isVisible(),true);
    if(size.touch){
      const before=await list.evaluate(el=>el.scrollTop), box=await list.boundingBox();
      const cdp=await context.newCDPSession(page), x=box.x+box.width/2, y=box.y+box.height*.8;
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
      for(let step=1;step<=8;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-step*15}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await page.waitForFunction(before=>document.querySelector('.dsh-picker-list').scrollTop>before,before);await cdp.detach();
    }
    // API name + flexible punctuation + model ID; same names must retain routes.
    await search.fill('codebuddy deepseekv4');assert.equal(await rows.count(),1);assert.equal(await rows.first().getAttribute('data-provider'),'api-1');
    await search.fill('glm53');assert.equal(await rows.count(),18);
    await page.getByRole('combobox',{name:'API 来源'}).selectOption('api-3');assert.equal(await rows.count(),1);
    await page.getByRole('button',{name:'收藏 GLM 5.3 · 来源 3',exact:true}).click();assert.equal(await page.evaluate(()=>window.calls.length),0);
    await page.getByRole('button',{name:'收藏',exact:true}).click();assert.equal(await rows.count(),1);
    await rows.first().click();await page.getByRole('dialog').waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>window.calls.at(-1)),{provider:'api-3',model:'glm-5.3'});
    await open();await page.getByRole('button',{name:'最近',exact:true}).click();assert.equal(await rows.count(),1);
    assert.equal(await rows.first().getAttribute('aria-checked'),'true');
    await page.getByRole('button',{name:'全部',exact:true}).click();await search.fill('不会存在的模型');assert.equal(await rows.count(),0);
    await search.press('Enter');assert.equal(await page.evaluate(()=>window.calls.length),1);
    await page.getByRole('button',{name:'清除筛选',exact:true}).click();assert.equal(await rows.count(),720);
    // Failed selection stays open and never enters history; next attempt recovers.
    await search.fill('codebuddy deepseekv4');await page.evaluate(()=>{window.reject=true;});await rows.first().click();
    await page.getByText('模型操作失败：test/rejected: fixture rejection',{exact:true}).waitFor();
    assert.equal(await page.getByRole('dialog').isVisible(),true);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('dsh:model-picker:v1')).recent.some(v=>v.provider==='api-1')),false);
    await page.evaluate(()=>{window.reject=false;});await search.fill('codebuddy deepseekv4');await search.press('Enter');await page.getByRole('dialog').waitFor({state:'hidden'});
    // Reasoning uses unchanged Host metadata. Favorites survive a reload.
    await page.reload();await open();await page.getByRole('button',{name:'推理等级 · High',exact:true}).click();
    await page.getByRole('menuitemradio',{name:'Low',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>window.calls.at(-1)),{provider:'api-1',model:'deepseek-v4-flash',reasoningEffort:'low'});
    await open();await page.getByRole('button',{name:'收藏',exact:true}).click();assert.equal(await rows.count(),1);assert.equal(await rows.first().getAttribute('data-provider'),'api-3');
    await page.getByRole('button',{name:'取消收藏 GLM 5.3 · 来源 3',exact:true}).click();assert.equal(await rows.count(),0);
    await page.getByRole('button',{name:'清除筛选',exact:true}).click();
    await search.fill('glm53');await search.press('Tab');assert.equal(await page.evaluate(()=>window.calls.length),1);
    // IME Enter does not pick a model; regular arrows and Enter pick one once.
    await search.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,isComposing:true,bubbles:true,cancelable:true})));assert.equal(await page.evaluate(()=>window.calls.length),1);
    await search.press('ArrowDown');await search.press('Enter');await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>window.calls.length),2);
    // Pending submission blocks duplicate clicks even before a React update.
    await open();await search.fill('glm53');await page.getByRole('combobox',{name:'API 来源'}).selectOption('api-5');
    await page.evaluate(()=>{window.deferred=true;});await rows.first().click();assert.equal(await rows.first().isDisabled(),true);
    await page.evaluate(()=>{window.resolveSelection();window.deferred=false;});await page.getByRole('dialog').waitFor({state:'hidden'});
    await open();await search.fill('deepseek');
    await page.screenshot({path:path.join(report,`picker-${size.width}${size.touch?'-touch':''}.png`)});
    if(size.touch){
      await page.setViewportSize({width:size.width,height:360});
      await page.waitForFunction(()=>{const r=document.querySelector('.dsh-picker').getBoundingClientRect();return r.y>=11&&r.bottom<=innerHeight-11;});
      assert(await list.evaluate(el=>el.clientHeight>40));
      await page.setViewportSize({width:size.width,height:size.height});
    }
    await search.press('Escape');assert.equal(await search.inputValue(),'');await search.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
    // Malformed/blocked storage does not stop choosing a model.
    await page.evaluate(()=>{localStorage.setItem('dsh:model-picker:v1','null');});await page.reload();await open();assert.equal(await rows.count(),720);
    await page.getByRole('button',{name:'关闭模型选择',exact:true}).click();
    await page.evaluate(()=>Object.defineProperty(window,'localStorage',{configurable:true,get(){throw Error('fixture storage blocked');}}));
    await open();await search.fill('codebuddy glm53');await rows.first().click();await page.getByRole('dialog').waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>window.calls.at(-1)),{provider:'api-1',model:'glm-5.3'});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    // 真正的对话页模型选择器 → Jet Hub 重置弹窗；全程只查询，不核销。
    await page.evaluate(()=>window.store.update(s=>{s.groups.push({id:'zcode',name:'ZCode',models:[{id:'GLM-5.3-Flash',name:'GLM-5.3-Flash'}]});}));
    await open();await page.getByRole('button',{name:'重置 ZCode 套餐额度',exact:true}).click();
    const resetDialog=page.getByRole('dialog',{name:'ZCode 套餐额度重置',exact:true});await resetDialog.waitFor();await page.getByText(/当前调用来源为“机构流量”/).waitFor();
    const target=page.getByRole('combobox',{name:'额度重置目标套餐',exact:true});assert.equal(await target.inputValue(),'');assert.equal(await page.evaluate(()=>window.resetCalls.filter(c=>c.method==='zcode.resetStatus').length),0);
    await target.selectOption('team:fixture:project');await page.getByText(/^5 小时重置：2 次/).waitFor();await page.getByRole('button',{name:'重置5 小时额度',exact:true}).click();await page.getByRole('dialog',{name:'确认消耗额度重置机会',exact:true}).waitFor();await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.evaluate(()=>window.resetCalls.filter(c=>c.method==='zcode.resetUse').length),0);
    assert(await resetDialog.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));await page.screenshot({path:path.join(report,`reset-picker-${size.width}${size.touch?'-touch':''}.png`)});await page.getByRole('button',{name:'关闭额度重置',exact:true}).click();await resetDialog.waitFor({state:'hidden'});
    await page.evaluate(()=>window.resetMulti=true);await open();await page.getByRole('button',{name:'重置 ZCode 套餐额度',exact:true}).click();await resetDialog.waitFor();const accountPicker=page.getByRole('combobox',{name:'重置额度的 ZCode 账号',exact:true});await page.waitForFunction(()=>document.querySelector('select[aria-label="重置额度的 ZCode 账号"]').options.length===3);assert.equal(await accountPicker.inputValue(),'');await page.evaluate(()=>window.resetFail=true);await accountPicker.selectOption('account-b');await page.getByRole('alert').filter({hasText:'套餐读取失败验证'}).waitFor();assert.equal(await page.getByRole('combobox',{name:'额度重置目标套餐',exact:true}).count(),0);await page.getByRole('button',{name:'关闭额度重置',exact:true}).click();await page.evaluate(()=>window.disposeReset());assert.equal(await page.evaluate(()=>typeof globalThis.__dshOpenZcodeReset),'undefined');
    results.push({size,models:720,directSearch:true,sourceAndIdSearch:true,exactRoute:true,favoritesAndRecent:true,mouseAndTouchScroll:true,insetBounds:true,imeAndTabSafe:true,pendingGuard:true,failedSelectionRecovery:true,reasoningPreserved:true,malformedStorageRecovery:true,composerResetEntry:true,resetTargetExplicit:true,noResetConsumed:true,resetScopeFailureRecovery:true});
    await context.close();
  }
  assert.deepEqual(errors,[]);
  const result={results,pageErrors:errors,externalInferenceRequests:0};
  await writeFile(path.join(report,'component-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
