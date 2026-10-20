import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {AppearanceStore} from './store.mjs';
import {catalog,themes} from './catalog.mjs';
test('migrate mint, keep legacy bytes, persist provider settings, reject stale tabs and invalid input',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'dsh-appearance-test-'));
 try{await mkdir(path.join(home,'appearance'));const legacy='{"skin":"mint","revision":9}\n';await writeFile(path.join(home,'appearance/theme.json'),legacy);
 const store=new AppearanceStore(home);await store.init();assert.equal(store.status().theme,'local:mint');assert.equal(await readFile(store.legacy,'utf8'),legacy);
 let state=await store.change({revision:0,theme:'oil:proof',options:{uiFont:'serif',accent:'#267660'}});assert.equal(state.options.uiFont,'serif');
 const concurrent=await Promise.allSettled([store.change({revision:1,theme:'dream:abyss'}),store.change({revision:1,theme:'gallery:catppuccin'})]);assert.deepEqual(concurrent.map(v=>v.status),['fulfilled','rejected']);
 await assert.rejects(store.change({revision:2,theme:'../../config'}));await assert.rejects(store.change({revision:2,options:{wallpaper:'https://example.com/leak'}}));await assert.rejects(store.change({revision:2,options:{accent:'red;display:none'}}));await assert.rejects(store.change({revision:2,options:{uiSize:99}}));
 await assert.rejects(store.change({revision:2,options:{constructor:true}}));
 state=await store.change({revision:2,theme:'oil:proof'});assert.equal(state.options.accent,'#267660');
 const reloaded=new AppearanceStore(home);await reloaded.init();assert.deepEqual(reloaded.status(),store.status());
 assert.equal(await readFile(store.legacy,'utf8'),legacy);
 }finally{await rm(home,{recursive:true});}
});
test('failed atomic persistence preserves the previous state; later writes recover',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'dsh-appearance-test-'));let fail=true;
 try{const store=new AppearanceStore(home,{rename:async(...args)=>{if(fail)throw Error('fixture disk full');const fs=await import('node:fs/promises');return fs.rename(...args);}});await store.init();
 await assert.rejects(store.change({revision:0,theme:'dream:abyss'}),/disk full/);assert.equal(store.status().theme,'local:original');assert.equal(store.status().revision,0);
 fail=false;await store.change({revision:0,theme:'local:mint'});assert.equal(JSON.parse(await readFile(store.file)).theme,'local:mint');
 }finally{await rm(home,{recursive:true});}
});
test('all pinned recipes and paired tokens are loadable with unique, local asset paths',async()=>{
 assert.deepEqual(catalog.providers.map(p=>p.themes.length),[3,38,8,5,15,151,4]);assert.equal(themes.size,224);
 for(const theme of themes.values()){assert.match(theme.file,/^[\w-]+$/);const recipe=JSON.parse(await readFile(new URL('./assets/themes/'+theme.file+'.json',import.meta.url)));assert.equal(recipe.id,theme.id);
 for(const [key,value]of Object.entries(recipe.tokens)){assert.match(key,/^--[\w-]+$/);assert.equal(typeof value.light,'string');assert.equal(typeof value.dark,'string');}
 const css=await readFile(new URL('./assets/themes/'+theme.file+'.css',import.meta.url),'utf8');assert(!/url\s*\(/i.test(css));
 }
});
