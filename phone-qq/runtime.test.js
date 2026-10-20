import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import { PhoneRuntime, ENHANCEMENTS } from './runtime.js';
test('compatible runtime edits are backed up, syntax checked, persisted and exactly reversible',async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'phone-runtime-')),root=path.join(temp,'tree'),home=path.join(temp,'home');await mkdir(home);const originals=new Map();
 try{for(const feature of ENHANCEMENTS){const file=path.join(root,'node_modules',feature.file);await mkdir(path.dirname(file),{recursive:true});const source=feature.replacements.map(([before])=>before).join('\n');originals.set(file,source);await writeFile(file,source);}
 const runtime=new PhoneRuntime(root,home),state=await runtime.status();assert.ok(state.features.every(f=>f.supported));assert.equal(state.catalog.length,40);
 await runtime.save(['read-caps'],0);const applied=await runtime.status();assert.equal(applied.features.find(f=>f.id==='read-caps').installed,true);await assert.rejects(runtime.save([],0));await runtime.save([],1);for(const [file,source]of originals)assert.equal(await readFile(file,'utf8'),source);
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('a runtime mismatch fails closed and does not overwrite the changed source',async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'phone-runtime-drift-')),home=path.join(temp,'home');await mkdir(home);const feature=ENHANCEMENTS[1],file=path.join(temp,'tree/node_modules',feature.file);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'const changed = true;');try{await assert.rejects(new PhoneRuntime(path.join(temp,'tree'),home).change(feature,true));assert.equal(await readFile(file,'utf8'),'const changed = true;');}finally{await rm(temp,{recursive:true,force:true});}
});
