/** Execute exact ShadowWebView output from MainIncomingIntegrationTest in real Chromium, never a handwritten bridge substitute.
 * DSH_INCOMING_SCRIPT_REPORT=/absolute/Main-export.json node --test scripts/main-incoming-browser.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const sourcePath=process.env.DSH_INCOMING_SCRIPT_REPORT??path.join(root,'app/build/reports/incoming/main-incoming-scripts.json');
const raw=await readFile(sourcePath,'utf8'),scripts=JSON.parse(raw);
const {chromium}=await import(pathToFileURL(process.env.DSH_PLAYWRIGHT_MODULE??path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
const browser=await chromium.launch({headless:true}),cases=[];
const output=process.env.DSH_INCOMING_BROWSER_REPORT??path.join(root,'app/build/reports/incoming/chromium.json');
test.after(async()=>{await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify({browser:browser.version(),exportPath:sourcePath,exportSha256:createHash('sha256').update(raw).digest('hex'),cases},null,2)+'\n');await browser.close();});
async function fixture(t,{target=true}={}) {
 const page=await browser.newPage();t.after(()=>page.close());
 await page.setContent(`<form id="old" data-conversation-session="old-session"><section data-composer-card><textarea>old draft</textarea><button type="submit">Send</button></section></form>${target?`<form id="target" data-conversation-session="${scripts.targetSession}"><section data-composer-card><textarea>target draft</textarea><button type="submit">Send</button></section></form>`:''}`);
 await page.evaluate(()=>{window.events=[];window.sends=0;window.inputEvents=0;document.addEventListener('submit',e=>{e.preventDefault();window.sends++;});document.addEventListener('click',()=>window.sends++);document.addEventListener('input',()=>window.inputEvents++);document.querySelectorAll('[data-composer-card]').forEach(card=>card.addEventListener('dsh:insert-file-references',e=>{window.events.push({id:e.target.closest('[data-conversation-session]').getAttribute('data-conversation-session'),references:e.detail.references});e.detail.accepted=true;}));window.navigations=[];window.__dshPhoneOpenIncomingSession=id=>{window.navigations.push(id);return new Promise((resolve,reject)=>{window.allowNavigation=resolve;window.failNavigation=reject;});};});
 return page;
}
const run=(page,name)=>page.evaluate(source=>window.eval(source),scripts[name]);
const snapshot=page=>page.evaluate(()=>({events:window.events,sends:window.sends,inputs:window.inputEvents,old:document.querySelector('#old textarea').value,target:document.querySelector('#target textarea')?.value,navigations:window.navigations}));
test('pending native navigation cannot deliver early, then only exact target receives original references',async t=>{
 const p=await fixture(t);assert.equal(await run(p,'referenceTarget'),false);assert.equal((await snapshot(p)).events.length,0);
 await p.evaluate(()=>window.allowNavigation());assert.equal(await run(p,'referenceTarget'),true);const s=await snapshot(p);assert.deepEqual(s.navigations,[scripts.targetSession]);assert.equal(s.events.length,1);assert.equal(s.events[0].id,scripts.targetSession);assert.deepEqual(s.events[0].references,scripts.references);assert.equal(s.old,'old draft');assert.equal(s.sends,0);cases.push({name:t.name,passed:true});
});
test('missing target never falls back to old composer even when navigation promise resolves',async t=>{
 const p=await fixture(t,{target:false});assert.equal(await run(p,'referenceTarget'),false);await p.evaluate(()=>window.allowNavigation());assert.equal(await run(p,'referenceTarget'),false);const s=await snapshot(p);assert.equal(s.events.length,0);assert.equal(s.old,'old draft');assert.equal(s.sends,0);cases.push({name:t.name,passed:true});
});
test('missing hook and rejected navigation return retryable signals without touching old composer',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{window.savedHook=window.__dshPhoneOpenIncomingSession;delete window.__dshPhoneOpenIncomingSession;});assert.equal(await run(p,'referenceTarget'),false);
 await p.evaluate(()=>window.__dshPhoneOpenIncomingSession=window.savedHook);assert.equal(await run(p,'referenceTarget'),false);await p.evaluate(()=>window.failNavigation(Error('synthetic navigation failed')));assert.deepEqual(await run(p,'referenceTarget'),{error:'synthetic navigation failed'});assert.equal((await snapshot(p)).events.length,0);assert.equal((await snapshot(p)).sends,0);cases.push({name:t.name,passed:true});
});
test('explicit attach-current keeps old behavior, while temporary text uses exact new composer and real blank lines',async t=>{
 const p=await fixture(t);assert.equal(await run(p,'referenceLegacy'),true);assert.equal((await snapshot(p)).events[0].id,'old-session');
 assert.equal(await run(p,'textTarget'),true);let s=await snapshot(p);assert.equal(s.target,'target draft\n\nincoming text');assert.equal(s.old,'old draft');assert.equal(s.inputs,1);assert.equal(s.sends,0);
 assert.equal(await run(p,'textLegacy'),true);s=await snapshot(p);assert.equal(s.old,'old draft\n\nincoming text');assert.equal(s.sends,0);cases.push({name:t.name,passed:true});
});
test('temporary text with missing target does not touch old draft and does not send',async t=>{
 const p=await fixture(t,{target:false});assert.equal(await run(p,'textTarget'),false);const s=await snapshot(p);assert.equal(s.old,'old draft');assert.equal(s.inputs,0);assert.equal(s.sends,0);cases.push({name:t.name,passed:true});
});
