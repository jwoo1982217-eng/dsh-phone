import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';
const root=fileURLToPath(new URL('../',import.meta.url));
const report=process.argv[2] ?? path.join(os.tmpdir(),'dsh-browser-dom');
await mkdir(report,{recursive:true});
const script=await readFile(path.join(root,'app/src/main/assets/dsh-browser-dom.js'),'utf8');
const {chromium}=await import(pathToFileURL(process.env.DSH_PLAYWRIGHT_MODULE ?? path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
const browser=await chromium.launch({headless:true});
const page=await browser.newPage(); const checks=[];
const check=(name,fn)=>fn().then(()=>checks.push(name));
try {
 await page.setContent('<button onclick="window.hit=1">Same</button><button onclick="window.hit=2">Same</button><input name="same"><input name="same"><textarea></textarea><div contenteditable="true"></div><button disabled>Disabled</button>');
 await page.evaluate(script);
 await check('duplicate-label buttons receive unique actionable refs',async()=>{
  const snapshot=await page.evaluate(()=>window.__dshBrowserDom.snapshot());
  assert.notEqual(snapshot.elements[0].selector,snapshot.elements[1].selector);
  assert.match(snapshot.elements[1].ref,/^dsh-ref:/);
  assert.equal(await page.evaluate(s=>window.__dshBrowserDom.click(s),snapshot.elements[1].selector).then(r=>r.ok),true);
  assert.equal(await page.evaluate(()=>window.hit),2);
 });
 await check('ambiguous CSS cannot silently click first match',async()=>{
  const result=await page.evaluate(()=>window.__dshBrowserDom.click('button'));
  assert.match(result.error,/多个/); assert.equal(await page.evaluate(()=>window.hit),2);
 });
 await check('old snapshot refs are rejected after a new snapshot',async()=>{
  const old=await page.evaluate(()=>window.__dshBrowserDom.snapshot().elements[0].selector);
  await page.evaluate(()=>window.__dshBrowserDom.snapshot());
  assert.match((await page.evaluate(s=>window.__dshBrowserDom.click(s),old)).error,/失效/);
 });
 await check('replaced node cannot reuse a ref to target another element',async()=>{
  const s=await page.evaluate(()=>window.__dshBrowserDom.snapshot().elements[0].selector);
  await page.evaluate(()=>{const old=document.querySelector('button');old.replaceWith(old.cloneNode(true));});
  assert.match((await page.evaluate(s=>window.__dshBrowserDom.click(s),s)).error,/失效/);
 });
 await check('input textarea and editable typing dispatch input events',async()=>{
  for(const selector of ['input[name=same]:nth-of-type(2)','textarea','[contenteditable=true]']){
   await page.evaluate(s=>document.querySelector(s).addEventListener('input',()=>window.inputEvents=(window.inputEvents||0)+1),selector);
   assert.equal((await page.evaluate(({s,text})=>window.__dshBrowserDom.type(s,text),{s:selector,text:'中文 " \\ draft'})).ok,true);
   assert.equal(await page.locator(selector).evaluate(e=>e.isContentEditable?e.textContent:e.value),'中文 " \\ draft');
  }
  assert.equal(await page.evaluate(()=>window.inputEvents),3);
 });
 await check('disabled and non-editable targets fail explicitly',async()=>{
  assert.match((await page.evaluate(()=>window.__dshBrowserDom.click('button[disabled]'))).error,/禁用/);
  assert.match((await page.evaluate(()=>window.__dshBrowserDom.type('button[disabled]','bad'))).error,/禁用/);
  assert.match((await page.evaluate(()=>window.__dshBrowserDom.type('button:first-child','bad'))).error,/输入/);
 });
 await check('navigation invalidates old references and missing nodes are explicit',async()=>{
  const ref=await page.evaluate(()=>window.__dshBrowserDom.snapshot().elements[0].ref);
  await page.setContent('<button>New document</button>'); await page.evaluate('delete window.__dshBrowserDom');await page.evaluate(script);
  assert.match((await page.evaluate(s=>window.__dshBrowserDom.click(s),ref)).error,/失效/);
  assert.match((await page.evaluate(()=>window.__dshBrowserDom.click('#absent'))).error,/不存在/);
 });
 await check('large document stays bounded and excluded hidden inputs do not leak values',async()=>{
  await page.setContent('<input type="hidden" value="private-hidden"><input type="password" value="private-password">'+Array.from({length:260},()=>'<button>item</button>').join(''));
  await page.evaluate(script);const s=await page.evaluate(()=>window.__dshBrowserDom.snapshot());
  assert.equal(s.elements.length,200);assert(!JSON.stringify(s).includes('private-hidden'));assert(!JSON.stringify(s).includes('private-password'));
 });
 await check('a failed action does not poison the next valid action',async()=>{
  await page.evaluate(()=>window.__dshBrowserDom.click('['));
  const s=await page.evaluate(()=>window.__dshBrowserDom.snapshot());
  assert.equal((await page.evaluate(ref=>window.__dshBrowserDom.click(ref),s.elements.find(e=>e.tag==='BUTTON').ref)).ok,true);
 });
 await writeFile(path.join(report,'verification.json'),JSON.stringify({passed:checks.length,checks},null,2));
 console.log(JSON.stringify({passed:checks.length,checks}));
} finally {await browser.close();}
