import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// 从实际覆盖产物取出编辑器和输入栏，仅在测试副本暴露内部符号。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = process.argv[2] ?? path.join(os.tmpdir(), 'dsh-composer-newline');
await mkdir(report, { recursive: true });
const require = createRequire(path.join(root, 'vendor/dsh-codearts-auth/package.json'));
const { build } = require('esbuild');
const playwright = process.env.DSH_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwright));
const source = await readFile(path.join(root, 'runtime/overlays/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'), 'utf8');
assert.equal(source.split('return module.exports;').length, 2);
const tested = source.replace('return module.exports;', 'module.exports.test = { InputBar, DraftEditorRuntime, registerComposerKeymap, enterCommand: cn$1 }; return module.exports;');
const bundled = await build({ stdin: { resolveDir: path.join(root, 'vendor/dsh-codearts-auth'), loader: 'js', contents: `
import React from 'react'; import * as jsx from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom'; import { createRoot } from 'react-dom/client';
window.__ModuleLoader__ = { load({factory}) {
  window.conversation = factory(id => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return jsx;
    if (id === 'react-dom') return ReactDOM;
    if (id === '@deepseek-ai/cordis') return { Service: class Service {} };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {
      Tooltip: ({children}) => children, Toast: ({text}) => React.createElement('div', {role:'alert'}, text),
      IconPlusOutlineMedium: () => React.createElement('span', {}, '+'),
      useAnchoredPosition: () => ({}), useDismissOnOutsidePointer: () => {}
    };
    return {};
  });
}};
${tested}
const { InputBar, DraftEditorRuntime } = window.conversation.test;
window.sends = []; window.stopCount = 0; window.popup = false; window.picks = 0;
window.fixture = { running:false, phase:'plain', locked:false, attachment:false, upload:'ready', busyEnter:'queue' };
let redraw = () => {};
const runtime = new DraftEditorRuntime({ onUpdate: () => { runtime.refreshProjection(); redraw(); },
  activeClaimToken: () => undefined, lexicon: () => undefined, resolveLexicon: () => undefined, openReference: () => {} });
runtime.register(); window.runtime = runtime;
const keyboard = { editor: runtime.editor, arbitrate: key => { if (window.popup && key==='enter') { window.picks++; return 'consumed'; } return 'pass'; },
  dismissPopup: () => {window.popup=false;}, space: () => false, paste: text => runtime.paste(text),
  bindFilePicker: () => () => {}, caretSpan: () => null,
  submit: (mode,origin) => window.sends.push({mode,origin,text:runtime.projection.clipboardText}), steerQueue: () => {} };
function App() {
  const [,setTick] = React.useState(0); redraw = () => setTick(n => n+1); window.redraw = redraw;
  const f = window.fixture; const draft = runtime.projection.clipboardText;
  const useInput = selector => selector({draft,phase:f.phase,queue:[],attachmentIds:f.attachment?['file']:[]});
  const useSession = selector => selector({running:f.running,removed:false,subagent:null});
  const t = key => ({'input.send':'发送消息','input.send.button':'发送','input.send.queue':'排队发送','input.send.steer':'插话发送','input.stop':'停止','placeholder.default':'输入消息','input.commands':'命令','file.stillUploading':'附件上传中'})[key] ?? key;
  return React.createElement(InputBar, { useInput,useSession,t,keyboard,inputActions:{pruneAttachments:()=>{}},
    resolveDraftAttachments: ids => ids.map(id=>({id,kind:'file'})),
    useBusyEnter:s=>s(f.busyEnter),useFileUploads:s=>s({file:{status:f.upload}}),
    useNotices:s=>s(null),useLexicon:s=>s(undefined),useMenuLauncher:s=>s(null),useStopShortcut:s=>s([]),
    useProjection: (_,selector) => selector?selector(undefined):undefined,
    renderSlot: () => null, stop:()=>window.stopCount++, variant:'composer',sessionId:'isolated-fixture',disabled:f.locked });
}
createRoot(document.getElementById('app')).render(React.createElement(App));
` }, nodePaths: [path.join(root, 'desktop-runtime/node_modules'), path.join(root, 'runtime/node_modules')], bundle: true, platform: 'browser', format: 'iife', write: false });

const presentation=await readFile(path.join(root,'app/src/main/assets/dsh-phone.js'),'utf8');
const helper=await readFile(path.join(root,'phone-qq/skill-import.js'),'utf8');
const browser=await chromium.launch({headless:true});const results=[];
try{for(const width of [393,692]){
 const context=await browser.newContext({viewport:{width,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));let mode='success',releaseUpload,startedUpload;let startPromise;
 const sample=Buffer.from(JSON.stringify({records:Array.from({length:10000},(_,i)=>({id:i,value:'中文完整内容😀'}))}));
 const stored={path:'/data/user/0/com.dshphone/files/dsh-home/uploads/chat-files/0123456789abcdef0123456789abcdef/content/分析.json',size:sample.length};let received;
 await context.route('http://127.0.0.1:32181/**',async route=>{const req=route.request(),url=new URL(req.url());
  if(url.pathname==='/phone-skill-import.js'){await route.fulfill({contentType:'text/javascript',body:helper});return;}
  if(url.pathname==='/phone-chat-files/upload'){
   received=req.postDataBuffer();startedUpload?.();await new Promise(r=>releaseUpload=r);
   if(mode==='failure')await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({ok:false,error:'测试上传中断'})});
   else await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,file:stored})});return;
  }
  await route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script>'+bundled.outputFiles[0].text+'</script>'});
 });
 await page.goto('http://127.0.0.1:32181/');const input=page.locator('[data-composer-input]'),send=page.locator('[data-composer-send]');await input.waitFor();await page.addScriptTag({content:presentation});await page.locator('.dsh-phone-upload-picker').waitFor({state:'attached'});
 await input.click();await page.keyboard.insertText('请分析记录数量');const original=await page.evaluate(()=>window.runtime.projection.clipboardText);
 startPromise=new Promise(r=>startedUpload=r);await page.locator('.dsh-phone-upload-picker').setInputFiles({name:'分析.json',mimeType:'application/json',buffer:sample});await startPromise;
 assert.equal(await page.locator('[data-composer-card]').getAttribute('data-dsh-file-upload-pending'),'true');await send.click();await input.click();await page.keyboard.press('Control+Enter');assert.equal(await page.evaluate(()=>window.sends.length),0);
 releaseUpload();await page.waitForFunction(()=>!document.querySelector('[data-composer-card]').dataset.dshFileUploadPending);await page.waitForFunction(()=>window.runtime.projection.clipboardText.includes('文件位置：'));
 assert.deepEqual(received,sample);const draft=await page.evaluate(()=>window.runtime.projection.clipboardText);assert.ok(draft.startsWith(original));assert.ok(draft.includes(stored.path));assert.ok(!draft.includes('中文完整内容'));assert.ok(draft.length<1024);assert.equal(await page.evaluate(()=>window.sends.length),0);await send.click();assert.equal(await page.evaluate(()=>window.sends.length),1);assert.equal(await page.evaluate(()=>window.sends[0].text),draft);
 mode='failure';startPromise=new Promise(r=>startedUpload=r);await page.locator('.dsh-phone-upload-picker').setInputFiles({name:'分析.json',mimeType:'application/json',buffer:sample});await startPromise;releaseUpload();await page.waitForFunction(()=>!document.querySelector('[data-composer-card]').dataset.dshFileUploadPending);assert.equal(await page.evaluate(()=>window.runtime.projection.clipboardText),draft);assert.ok((await page.locator('[role=status]').last().textContent()).includes('测试上传中断'));assert.equal(await page.locator('.dsh-phone-upload').isEnabled(),true);
 mode='success';startPromise=new Promise(r=>startedUpload=r);await page.locator('.dsh-phone-upload-picker').setInputFiles({name:'分析.json',mimeType:'application/json',buffer:sample});await startPromise;releaseUpload();await page.waitForFunction(()=>!document.querySelector('[data-composer-card]').dataset.dshFileUploadPending);await page.waitForFunction(()=>window.runtime.projection.clipboardText.split('文件位置：').length===3);
 assert.equal(await page.evaluate(()=>window.sends.length),1);assert.equal(errors.length,0);results.push({viewport:width,actualLexicalAndInputBar:true,bytes:sample.length,fullBytesUploaded:true,draftContainsFileReference:true,originalDraftPreserved:true,sendBlockedDuringUpload:true,buttonSubmitsOnce:true,failurePreservesDraft:true,retryWorks:true,errors});await context.close();
}}finally{await browser.close();}await writeFile(path.join(report,'large-upload-ui.json'),JSON.stringify({results},null,2));console.log(JSON.stringify({results}));
