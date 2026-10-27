import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {frontendShared} from './fixtures/frontend-shared.mjs';
test('real raw settings directory contains one appearance row; removing center restores legacy',async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url)),dist=path.join(root,'runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist');
 const {shared}=await frontendShared(dist);
 const source=await readFile(new URL('../peer/agent-cards/client-source.js',import.meta.url),'utf8');
 const helper=source.slice(source.indexOf('function registerLegacyAppearance'),source.indexOf('/** React 18'));
 const {chromium}=await import(pathToFileURL(process.env.DSH_PLAYWRIGHT_MODULE??path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('**/*',async route=>{const u=new URL(route.request().url());assert.equal(u.hostname,'127.0.0.1');
   const body=u.pathname==='/assets/shared.js'?shared:u.pathname.startsWith('/assets/')?await readFile(path.join(dist,u.pathname),'utf8'):'<script type="module" src="/assets/shared.js"></script>';
   await route.fulfill({contentType:u.pathname.endsWith('.js')?'text/javascript':'text/html',body});
  });
  await page.goto('http://127.0.0.1:37967/');await page.waitForFunction(()=>window.__TEST_SHARED__);
  const values=await page.evaluate(code=>{
   const {SlotCore}=window.__TEST_SHARED__['@deepseek-ai/dsh-client-ui-slots'];
   const register=new Function(code+';return registerLegacyAppearance')();
   const slots=new SlotCore(),listeners=new Set();slots.register({name:'root',children:{'settings.section':{kind:'list',scope:'root'}}},()=>null);
   slots.onMutate(key=>{for(const fn of listeners)fn(key);});
   const ctx={slots:{inject:(key,fn)=>fn(),register:(...args)=>slots.register(...args),entriesOfSlot:key=>slots.entriesOfSlot(key)},on:(event,fn)=>{listeners.add(fn);return()=>listeners.delete(fn);}};
   const cleanup=register(ctx,{name:'settings.section',id:'appearance',label:'外观皮肤'},()=>null);
   const first=slots.entries('settings.section').length;
   const remove=slots.register({name:'settings.section',id:'appearance',label:'外观',priority:-100},()=>null);
   const replaced=slots.entries('settings.section').map(e=>e.options.label);
   slots.register({name:'settings.section',id:'another',label:'其他插件'},()=>null);const withOther=slots.entries('settings.section').length;
   remove();const restored=slots.entriesOfSlot('settings.section').find(e=>e.options.id==='appearance').options.label;
   cleanup();return{first,replaced,withOther,restored,last:slots.entries('settings.section').length,listeners:listeners.size};
  },helper);
  assert.equal(values.first,1);assert.deepEqual(values.replaced,['外观']);assert.equal(values.withOther,2);assert.equal(values.restored,'外观皮肤');assert.equal(values.last,1);assert.equal(values.listeners,0);
 }finally{await browser.close();}
});
