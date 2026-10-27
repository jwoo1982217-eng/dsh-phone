import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// The production SDK component, not a hand-built editor lookalike. All profile
// data and operations are local fixtures; this never calls a model or account.
export async function modelEditorFixture({beforeCompat} = {}) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const read = name => readFile(path.join(root, name), 'utf8');
  const require = createRequire(path.join(root, 'vendor/dsh-codearts-auth/package.json'));
  const {build} = require('esbuild');
  const client = (await read('runtime/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js'))
    .replace('exports.apply = apply;', 'exports.ModelsSection = ModelsSection; exports.apply = apply;');
  if (!client.includes('exports.ModelsSection = ModelsSection')) throw Error('Pinned Models component boundary missing');
  const previous = beforeCompat ? await readFile(beforeCompat, 'utf8') : '';
  const current = await read('phone-qq/cards-client.js');
  const native = await read('app/src/main/assets/dsh-settings-embed.js');
  const script = (await build({stdin:{resolveDir:path.join(root,'vendor/dsh-codearts-auth'),contents:`
import React from 'react'; import * as jsx from 'react/jsx-runtime'; import {createRoot} from 'react-dom/client';
window.__fixtureErrors=[];window.addEventListener('error',event=>window.__fixtureErrors.push(event.message));
const originalNative=window.structuredClone;
const mode=new URLSearchParams(location.search).get('mode')||'bundle';
if(mode!=='modern')window.structuredClone=undefined;
${previous}
let sdk;
const icon=()=>null;
window.__ModuleLoader__={load:({id,factory})=>{const value=factory(name=>name==='react'?React:name==='react/jsx-runtime'?jsx:name==='@deepseek-ai/dsh-client-ui-primitives'?new Proxy({},{get:()=>icon}):{});if(id==='@deepseek-ai/dsh-client-ui-settings-models')sdk=value;}};
if(mode==='bundle'||mode==='modern'){${current}}
${client}
const profile={apiKeyEnv:'FIXTURE_API_KEY',baseURL:'https://fixture.invalid/v1',models:[{id:'fixture-model',name:'Fixture',contextWindow:4096}]};
const original=JSON.stringify(profile);let writes=0;
const namespace={ns:'llm-deepseek',revision:1,value:profile,user:profile,base:{models:[]},schema:{meta:{}}};
const schema={getPath:(value,keys)=>keys.reduce((v,k)=>v&&v[k],value),hasPath:(value,keys)=>keys.reduce((v,k)=>v&&v[k],value)!==undefined,rehydrate:x=>x,nodeAtPath:()=>({meta:{}})};
const snapshot={status:'ready',writable:true,rows:[{entry:{provider:'fixture-provider',displayName:'Fixture Provider',settingsNs:'llm-deepseek',settingsPath:[],models:[{id:'fixture-model'}]},configured:true,credential:{configured:true,writable:true},apiKeyEnv:'FIXTURE_API_KEY',removable:false}],namespaces:new Map([['llm-deepseek',namespace]])};
const operations={describeCredential:async()=>({configured:true,writable:true}),writeSettings:async()=>{writes++;throw Error('fixture must not save');},storeCredential:async()=>{writes++;throw Error('fixture must not store credentials');}};
const app=createRoot(document.getElementById('app'));
app.render(React.createElement(sdk.ModelsSection,{controller:{load:async()=>{},store:{getSnapshot:()=>snapshot}},useSnapshot:()=>snapshot,operations,schema,t:key=>key,renderSlot:()=>null}));
window.applyOwnedFallback=()=>{${native}};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async test=>{for(let i=0;i<100;i++){if(test())return;await pause(20);}throw Error('fixture UI timed out');};
const button=name=>Array.from(document.querySelectorAll('button')).find(x=>x.textContent===name);
window.runModelEditorFixture=async()=>{
 await wait(()=>button('edit'));
 if(mode==='native'){window.applyOwnedFallback();window.applyOwnedFallback();}
 const before={modelRow:!!document.querySelector('.zGbnIq_rowCard'),structuredClone:typeof structuredClone};
 button('edit').click();
 if(mode==='legacy'){
  await wait(()=>window.__fixtureErrors.length>0);
  return {mode,before,blank:!document.querySelector('.zGbnIq_section'),errors:window.__fixtureErrors,writes,profileUnchanged:JSON.stringify(profile)===original};
 }
 await wait(()=>document.querySelector('input[type=password]'));
 const editorVisible=!!document.querySelector('.zGbnIq_editor');
 const input=document.querySelector('input[type=password]');
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'fixture-unsaved');input.dispatchEvent(new Event('input',{bubbles:true}));
 button('cancel').click();await wait(()=>!document.querySelector('.zGbnIq_editor'));
 button('edit').click();await wait(()=>document.querySelector('input[type=password]'));
 const reopenedEmpty=document.querySelector('input[type=password]').value==='';
 button('cancel').click();await wait(()=>!document.querySelector('.zGbnIq_editor'));
 return {mode,before,editorVisible,reopenedEmpty,errors:window.__fixtureErrors,writes,profileUnchanged:JSON.stringify(profile)===original,nativeAvailable:typeof originalNative==='function',nativePreserved:mode!=='modern'||typeof originalNative!=='function'||originalNative===window.structuredClone};
};
`},bundle:true,format:'iife',platform:'browser',target:'chrome80',write:false})).outputFiles[0].text;
  return {script,html:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:12px;font:14px system-ui;background:white;color:black}</style><div id="app"></div><script src="/fixture.js"></script>'};
}
