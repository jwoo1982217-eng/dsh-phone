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
const referenceSource = await readFile(path.join(root,'runtime/overlays/@deepseek-ai/dsh-client-ui-reference/lib/client.js'),'utf8');
const bundled = await build({ stdin: { resolveDir: path.join(root, 'vendor/dsh-codearts-auth'), loader: 'js', contents: `
import React from 'react'; import * as jsx from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom'; import { createRoot } from 'react-dom/client';
window.__ModuleLoader__ = { load({id:moduleId,factory}) {
  const result = factory(id => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return jsx;
    if (id === 'react-dom') return ReactDOM;
    if (id === '@deepseek-ai/cordis') return { Service: class Service {} };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {
      Tooltip: ({children}) => children, Toast: ({text}) => React.createElement('div', {role:'alert'}, text),
      IconPlusOutlineMedium: () => React.createElement('span', {}, '+'), ReferenceIconRegular: () => React.createElement('span', {}, 'file'),
      useAnchoredPosition: () => ({}), useDismissOnOutsidePointer: () => {}
    };
    return {};
  });
  if(moduleId==='@deepseek-ai/dsh-client-ui-conversation')window.conversation=result;else window.referencePlugin=result;
}};
${tested}
${referenceSource}
window.referencePlugin.apply({effect:fn=>fn(),locale:{register(){},bind:()=>key=>key},get:name=>name==='sessions'?{list:{getSnapshot:()=>({byId:{}})}}:{registerSource:source=>{window.referenceSource=source;}},sidebarRight:{openResource:path=>{window.openedFile=path;}}});
const { InputBar, DraftEditorRuntime } = window.conversation.test;
window.sends = []; window.stopCount = 0; window.popup = false; window.picks = 0;
window.fixture = { running:false, phase:'plain', locked:false, attachment:false, upload:'ready', busyEnter:'queue' };
let redraw = () => {};
const runtime = new DraftEditorRuntime({ onUpdate: () => { runtime.refreshProjection(); redraw(); },
  activeClaimToken: () => undefined, lexicon: () => undefined, resolveLexicon: () => undefined, openReference: () => {} });
runtime.register(); window.runtime = runtime;
const keyboard = { editor: runtime.editor, arbitrate: key => { if (window.popup && key==='enter') { window.picks++; return 'consumed'; } return 'pass'; },
  dismissPopup: () => {window.popup=false;}, space: () => false, paste: text => runtime.paste(text),
  bindFilePicker: () => () => {}, caretSpan: () => null, addFiles: refs=>runtime.insertFileReferences(refs),
  submit: async (mode,origin) => { const p=runtime.projection;let text=p.clipboardText;const replacements=await Promise.all(p.occurrences.map(async o=>({...o,text:await window.referenceSource.codec.serialize(o.ref)})));for(const item of replacements.reverse())text=text.slice(0,item.offset)+item.text+text.slice(item.offset+item.length);window.sends.push({mode,origin,text}); }, steerQueue: () => {} };
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
` }, nodePaths: [path.join(root, 'desktop-runtime/node_modules'), path.join(root, 'runtime/node_modules')], bundle: true, platform: 'browser', format: 'iife', external:['/phone-skill-import.js'], write: false });

const presentation=await readFile(path.join(root,'app/src/main/assets/dsh-phone.js'),'utf8');
const helper=await readFile(path.join(root,'phone-qq/skill-import.js'),'utf8');
const browser=await chromium.launch({headless:true});const results=[];
try{for(const width of [393,692,1000]){
 const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));let failure=false,received;
 const filePath='/data/user/0/com.dshphone/files/dsh-home/uploads/chat-files/0123456789abcdef0123456789abcdef/content/书源.json';
 const original=JSON.stringify({page:'{{page}}',known:'{{provider}}',code:'{{ invalid }}',body:'不得展开的完整附件原文😀'});
 await context.route('http://127.0.0.1:32181/**',async route=>{const req=route.request(),url=new URL(req.url());
  if(url.pathname==='/phone-skill-import.js'){await route.fulfill({contentType:'text/javascript',body:helper});return;}
  if(url.pathname==='/phone-chat-files/upload'){
   received=req.postDataBuffer();await new Promise(r=>setTimeout(r,60));
   if(failure)await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({ok:false,error:'测试上传中断'})});
   else await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,file:{path:filePath,size:received.length,preview:{path:filePath,text:original,nextOffset:received.length,eof:true},downloadUrl:'http://192.168.1.23:45678/file/'+'a'.repeat(64)+'/book.json',downloadExpiresAt:'2026-10-17T00:00:00Z'}})});return;
  }
  await route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script>'+bundled.outputFiles[0].text+'</script>'});
 });
 await page.goto('http://127.0.0.1:32181/');const input=page.locator('[data-composer-input]'),send=page.locator('[data-composer-send]');await input.waitFor();await page.addScriptTag({content:presentation});const picker=page.locator('.dsh-phone-upload-picker');await picker.waitFor({state:'attached'});
 await input.click();await page.keyboard.insertText('请分析附件');
 await picker.setInputFiles({name:'书源.json',mimeType:'application/json',buffer:Buffer.from(original)});
 await page.waitForFunction(()=>window.runtime.projection.occurrences.length===1);
 assert.equal(received.toString(),original);assert.ok(!(await input.textContent()).includes('不得展开'));assert.ok((await input.textContent()).includes('书源.json'));assert.equal(await page.evaluate(()=>window.sends.length),0);
 const before=await page.evaluate(()=>window.runtime.projection.clipboardText);failure=true;await picker.setInputFiles({name:'失败.json',mimeType:'application/json',buffer:Buffer.from(original)});await page.waitForFunction(()=>!document.querySelector('[data-composer-card]').dataset.dshFileUploadPending);assert.equal(await page.evaluate(()=>window.runtime.projection.clipboardText),before);assert.equal(await page.evaluate(()=>window.runtime.projection.occurrences.length),1);
 failure=false;const large=Buffer.from(original+' '.repeat(150000));await picker.setInputFiles({name:'大文件.json',mimeType:'application/json',buffer:large});await page.waitForFunction(()=>window.runtime.projection.occurrences.length===2);assert.deepEqual(received,large);
 const binary=Buffer.from([80,75,3,4,0,255,1,2]);for(const name of ['软件.apk','无后缀','SKILL.md']){await picker.setInputFiles({name,mimeType:'application/octet-stream',buffer:binary});await page.waitForFunction(name=>window.runtime.projection.occurrences.some(x=>x.label===name),name);assert.deepEqual(received,binary);}
 await send.click();await page.waitForFunction(()=>window.sends.length===1);const sent=await page.evaluate(()=>window.sends[0].text);assert.ok(sent.includes('文件位置：'));assert.ok(sent.includes('chat_file_read'));assert.ok(sent.includes('192.168.1.23'));assert.ok(!sent.includes(original));assert.ok(sent.length<6000);assert.ok(sent.startsWith('请分析附件'));
 const count=await page.evaluate(()=>window.runtime.projection.occurrences.length);assert.equal(count,5);assert.equal(errors.length,0);
 await input.click();await page.keyboard.press('Control+End');await page.keyboard.press('Backspace');await page.keyboard.press('Backspace');await page.waitForFunction(count=>window.runtime.projection.occurrences.length<count,count);
 results.push({viewport:width,actualLexicalAndInputBar:true,actualReferenceSerializer:true,smallFileUploadedByteForByte:true,largeFileUploadedByteForByte:true,fileChips:count,originalNeverExpanded:true,metadataOnlySubmitted:true,remoteReadAddressPreserved:true,failurePreservesDraft:true,retryWorks:true,binaryAndSkillFilenameStayFiles:true,nativeBackspaceRemovesChip:true,errors});await context.close();
}}finally{await browser.close();}
await writeFile(path.join(report,'attachment-chips-ui.json'),JSON.stringify({results},null,2));console.log(JSON.stringify({results}));
