import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import os from 'node:os';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const report=path.resolve(process.argv[2]??path.join(os.tmpdir(),'dsh-browser-profile'));
await mkdir(report,{recursive:true});
const tmp=await mkdtemp(path.join(os.tmpdir(),'dsh-profile-java-'));
const java=path.join(process.env.JAVA_HOME??'/Applications/Android Studio.app/Contents/jbr/Contents/Home','bin');
function run(bin,args){const p=spawnSync(path.join(java,bin),args,{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout;}
await writeFile(path.join(tmp,'Script.java'),'import com.dshphone.browser.BrowserProfilePolicy; class Script {public static void main(String[] a){System.out.print(BrowserProfilePolicy.viewportScript(Integer.parseInt(a[0])));}}');
run('javac',['-d',tmp,path.join(root,'app/src/main/java/com/dshphone/browser/BrowserProfilePolicy.java'),path.join(tmp,'Script.java')]);
const {chromium}=await import(pathToFileURL(process.env.DSH_PLAYWRIGHT_MODULE??path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
const browser=await chromium.launch({headless:true});const checks=[],measurements=[];
try {
 for(const width of [412,1280]){
  const context=await browser.newContext({isMobile:true,viewport:{width:390,height:800}});
  const script=run('java',['-cp',tmp,'Script',String(width)]);
  await context.addInitScript(script);
  const page=await context.newPage();
  await page.route('https://fixture.test/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width"><body><button>same</button><button>same</button><script>setTimeout(()=>{document.querySelector("meta").content="width=900"},100)</script>'}));
  await page.goto('https://fixture.test/');
  await page.waitForFunction(w=>document.querySelector('meta[name=viewport]').content.startsWith('width='+w),width);
  await page.waitForTimeout(250);
  const measured=await page.evaluate(()=>({width:innerWidth,height:innerHeight,layoutWidth:document.documentElement.clientWidth,visualWidth:visualViewport.width,dpr:devicePixelRatio}));
  measurements.push({requestedWidth:width,...measured});
  // Mobile visual viewport scaling rounds the integer layout viewport upward by a CSS pixel.
  assert(measured.width>=width && measured.width<=width+1,JSON.stringify(measured));checks.push('actual Chromium mobile viewport '+width+' and late meta replacement');
  await page.waitForTimeout(3000);
  await page.evaluate(()=>document.querySelector('meta[name=viewport]').content='width=777');
  await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>document.querySelector('meta[name=viewport]').content),'width=777');checks.push('viewport observer stops after bounded window '+width);
  await page.evaluate(await readFile(path.join(root,'app/src/main/assets/dsh-browser-dom.js'),'utf8'));
  const snapshot=await page.evaluate(()=>window.__dshBrowserDom.snapshot());assert.notEqual(snapshot.elements[0].ref,snapshot.elements[1].ref);
  await page.reload();await page.evaluate(await readFile(path.join(root,'app/src/main/assets/dsh-browser-dom.js'),'utf8'));
  assert.match((await page.evaluate(ref=>window.__dshBrowserDom.click(ref),snapshot.elements[0].ref)).error,/失效/);checks.push('reload invalidates old DOM references '+width);
  await context.close();
 }
 await writeFile(path.join(report,'verification.json'),JSON.stringify({browser:await browser.version(),passed:checks.length,checks,measurements,scope:'Chromium mobile emulation; not Android WebView UA-CH/hardware verification'},null,2));console.log(JSON.stringify({passed:checks.length,checks}));
}finally{await browser.close();await rm(tmp,{recursive:true,force:true});}
