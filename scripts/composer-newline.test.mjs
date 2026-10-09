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
const phoneCSS = await readFile(path.join(root, 'app/src/main/assets/dsh-phone.css'), 'utf8')
  .catch(error => { if (error.code !== 'ENOENT') throw error; return readFile(path.join(root, 'peer/presentation.css'), 'utf8'); });
const browser = await chromium.launch({ executablePath: process.env.DSH_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const errors = [], results = [];
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? {width:393,height:852} : {width:1280,height:850}, hasTouch:mobile, isMobile:mobile });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await context.route('http://127.0.0.1:32181/**', route => route.fulfill({ contentType:'text/html', body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:20px;font:14px system-ui;--dsh-composer-side-clearance:8px;--dsh-composer-card-max-width:760px;--dsh-composer-text-max-height:160px;--dsw-alias-button-info-fill:#2563eb;--dsw-specific-input-major:#f2f5fa;--dsw-alias-label-primary:#18243b;--dsw-radius-panel:16px;--dsw-font-family:system-ui}'+(mobile?phoneCSS:'')+'</style><div id="app"></div><script>'+bundled.outputFiles[0].text+'</script>' }));
    await page.goto('http://127.0.0.1:32181/');
    const input = page.locator('[data-composer-input]'), send = page.locator('[data-composer-send]');
    await input.waitFor();
    assert.equal(await input.getAttribute('enterkeyhint'), 'enter');
    assert.equal(await send.innerText(), '发送');
    assert.equal(await send.isDisabled(), true);
    await input.click(); await page.keyboard.insertText('第一行'); await page.keyboard.press('Enter'); await page.keyboard.insertText('第二行');
    await page.waitForFunction(()=>window.runtime.projection.clipboardText==='第一行\n第二行');
    assert.equal(await page.evaluate(()=>window.sends.length), 0);
    assert.equal(await send.isDisabled(), false);
    assert.ok((await send.boundingBox()).width >= 68);
    await send.click();
    assert.deepEqual(await page.evaluate(()=>window.sends), [{mode:'queue',origin:'click',text:'第一行\n第二行'}]);
    await page.screenshot({path:path.join(report, mobile?'composer-phone.png':'composer-desktop.png')});
    await input.click(); await page.keyboard.press('Shift+Enter'); await page.keyboard.insertText('第三行');
    await page.waitForFunction(()=>window.runtime.projection.clipboardText==='第一行\n第二行\n第三行');
    assert.equal(await page.evaluate(()=>window.sends.length), 1);
    await page.keyboard.press('Control+Enter');
    assert.equal(await page.evaluate(()=>window.sends.length), 2);
    await page.keyboard.press('Meta+Enter');
    assert.equal(await page.evaluate(()=>window.sends.length), 3);
    // 输入法确认与菜单选择不得发送，也不得破坏草稿。
    const saved = await page.evaluate(()=>window.runtime.projection.clipboardText);
    await input.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:true,bubbles:true,cancelable:true})));
    assert.equal(await page.evaluate(()=>window.sends.length), 3);
    assert.equal(await page.evaluate(()=>window.runtime.projection.clipboardText), saved);
    await page.evaluate(()=>window.popup=true); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>window.picks), 1);
    assert.equal(await page.evaluate(()=>window.sends.length), 3);
    assert.equal(await page.evaluate(()=>window.runtime.projection.clipboardText), saved);
    await page.evaluate(()=>window.popup=false);
    // Android 软键盘 beforeinput 的无 keydown 路径使用真实 Lexical command。
    await page.evaluate(()=>window.runtime.editor.dispatchCommand(window.conversation.test.enterCommand,null));
    await page.keyboard.insertText('软键盘');
    await page.waitForFunction(()=>window.runtime.projection.clipboardText.endsWith('\n软键盘'));
    assert.equal(await page.evaluate(()=>window.sends.length), 3);
    // 沿用原发送模式与附件/锁定/正在提交的门控。
    const update = async values => { await page.evaluate(values=>{Object.assign(window.fixture,values);window.redraw();}, values); };
    await update({running:true}); await page.getByRole('button',{name:'排队发送',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.sends.at(-1).mode), 'queue');
    await update({busyEnter:'steer'}); await page.getByRole('button',{name:'插话发送',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.sends.at(-1).mode), 'steer');
    await update({locked:true}); await page.waitForFunction(()=>document.querySelector('[data-composer-send]').disabled);
    await update({locked:false,phase:'submitting'}); assert.equal(await send.isDisabled(),true);
    await update({phase:'plain',attachment:true,upload:'uploading'}); await page.waitForFunction(()=>document.querySelector('[data-composer-send]').disabled);
    const beforeUpload = await page.evaluate(()=>window.sends.length);
    await input.click(); await page.keyboard.press('Control+Enter');
    await page.getByRole('alert').filter({hasText:'附件上传中'}).waitFor();
    assert.equal(await page.evaluate(()=>window.sends.length),beforeUpload);
    await update({upload:'ready'}); await page.waitForFunction(()=>!document.querySelector('[data-composer-send]').disabled);
    await send.click(); assert.equal(await page.evaluate(()=>window.sends.length),beforeUpload+1);
    await page.evaluate(()=>{window.fixture.attachment=false;window.runtime.setDraft('');window.redraw();});
    await page.getByRole('button',{name:'停止',exact:true}).click(); assert.equal(await page.evaluate(()=>window.stopCount),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1), false);
    results.push({ mobile, actualLexicalAndInputBar:true, plainEnterNewline:true, shiftEnterNewline:true, softEnterNewline:true, buttonSendsMultilineOnce:true, ctrlAndCmdEnter:true, imeNoSend:true, menuNoSend:true, queueAndSteerPreserved:true, uploadAndLockGuards:true, uploadFailureRecovery:true, stopPreserved:true, noOverflow:true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  const out = { results, pageErrors:errors, externalInferenceRequests:0 };
  await writeFile(path.join(report, 'composer-verification.json'), JSON.stringify(out,null,2));
  console.log(JSON.stringify(out));
} finally { await browser.close(); }
