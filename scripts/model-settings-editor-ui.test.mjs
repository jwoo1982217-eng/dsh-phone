import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {modelEditorFixture} from './fixtures/model-settings-editor.mjs';
const out=process.argv[2]||path.join(os.tmpdir(),'dsh-model-editor-ui');await fs.mkdir(out,{recursive:true});
const fixture=await modelEditorFixture({beforeCompat:process.env.DSH_BEFORE_COMPAT});
await fs.writeFile(path.join(out,'fixture.js'),fixture.script);await fs.writeFile(path.join(out,'index.html'),fixture.html);
const {chromium}=await import(pathToFileURL(process.env.DSH_PLAYWRIGHT_MODULE||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
const browser=await chromium.launch({headless:true,...(process.env.DSH_CHROME?{executablePath:process.env.DSH_CHROME}:{})});
const result={browser:browser.version(),actualSdkModelsSection:true,modelRequests:0,cases:[]};
try{
 for(const mode of ['legacy','bundle','native','modern']){
  const context=await browser.newContext({viewport:{width:393,height:852}});const page=await context.newPage();
  await context.route('**/*',route=>{const u=new URL(route.request().url());assert.equal(u.hostname,'127.0.0.1');return route.fulfill({contentType:u.pathname==='/fixture.js'?'text/javascript':'text/html',body:u.pathname==='/fixture.js'?fixture.script:fixture.html});});
  await page.goto('http://127.0.0.1:32188/?mode='+mode);await page.waitForFunction(()=>typeof window.runModelEditorFixture==='function');
  const value=await page.evaluate(()=>window.runModelEditorFixture());
  if(mode==='legacy'){assert.equal(value.blank,true);assert.ok(value.errors.some(e=>e.includes('structuredClone')));}
  else {assert.equal(value.editorVisible,true);assert.equal(value.reopenedEmpty,true);assert.deepEqual(value.errors,[]);assert.equal(value.nativePreserved,true);}
  assert.equal(value.profileUnchanged,true);assert.equal(value.writes,0);
  if(mode!=='legacy'){
   await page.locator('button').filter({hasText:/^edit$/}).click();await page.locator('.zGbnIq_editor').waitFor();
   value.editorRect=await page.locator('.zGbnIq_editor').evaluate(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}));
   assert.ok(value.editorRect.width>200&&value.editorRect.height>100);
  }
  result.cases.push(value);
  await page.screenshot({path:path.join(out,mode+'.png')});await context.close();
 }
 result.passed=true;
}finally{await fs.writeFile(path.join(out,'model-editor-ui.json'),JSON.stringify(result,null,2));await browser.close();}
console.log(JSON.stringify(result));
