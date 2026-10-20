import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./client.js',import.meta.url),'utf8');
function load(importModuleDynamically){
 let plugin;const warnings=[],disposers=[];
 vm.runInNewContext(source,{window:{__ModuleLoader__:{load:entry=>{plugin=entry.factory();}}},console:{warn:(...args)=>warnings.push(args)},AbortController},{importModuleDynamically});
 const ctx={effect(fn){const dispose=fn();if(typeof dispose==='function')disposers.push(dispose);},theme:{getTheme(){throw Error('A disposed initializer must not touch theme services');}}};
 return {plugin,ctx,warnings,dispose(){for(const dispose of disposers.reverse())dispose();}};
}
test('a stalled optional appearance import does not hold plugin or chat boot open',async()=>{
 let entered=false;const fixture=load(()=>{entered=true;return new Promise(()=>{});});
 assert.equal(fixture.plugin.apply(fixture.ctx),undefined);await new Promise(setImmediate);assert.equal(entered,true);fixture.dispose();assert.equal(fixture.warnings.length,0);
});
test('failed appearance restoration reports locally without rejecting global boot',async()=>{
 const fixture=load(async()=>{throw Error('fixture appearance asset unavailable');});
 assert.equal(fixture.plugin.apply(fixture.ctx),undefined);await new Promise(setImmediate);assert.equal(fixture.warnings.length,1);assert.match(String(fixture.warnings[0][0]),/聊天仍可使用/);fixture.dispose();
});
test('disposal before a late appearance import prevents theme and DOM changes',async()=>{
 let resolveImport;const gate=new Promise(resolve=>{resolveImport=resolve;});
 const module=new vm.SyntheticModule(['createVisuals','composeTokens','recipeFor'],function(){for(const key of ['createVisuals','composeTokens','recipeFor'])this.setExport(key,()=>{throw Error('disposed initialization ran');});});
 await module.link(()=>{});await module.evaluate();
 const fixture=load(()=>gate);fixture.plugin.apply(fixture.ctx);fixture.dispose();resolveImport(module);await new Promise(setImmediate);assert.equal(fixture.warnings.length,0);
});

function statusFixture({ignoreAbort=false}={}){
 let plugin,resolveResponse,fetchSignal;const warnings=[],disposers=[],changes=[];let openedChannels=0;
 const response=new Promise(resolve=>{resolveResponse=resolve;});
 const visual={dispose(){},sync(){},async prepare(){return {cancel(){},commit(){changes.push('commit');}};}};
 const module=new vm.SyntheticModule(['createVisuals','composeTokens','recipeFor'],function(){this.setExport('createVisuals',()=>visual);this.setExport('composeTokens',()=>({}));this.setExport('recipeFor',async()=>({mode:'dual'}));});
 const document={querySelectorAll:()=>[],addEventListener(){},removeEventListener(){}};
 const window={__ModuleLoader__:{load:entry=>{plugin=entry.factory();}},addEventListener(){},removeEventListener(){}};
 vm.runInNewContext(source,{window,document,URL,location:{href:'http://127.0.0.1/',origin:'http://127.0.0.1'},console:{warn:(...args)=>warnings.push(args)},AbortController,crypto:{randomUUID:()=> 'fixture-id'},queueMicrotask,BroadcastChannel:class{constructor(){openedChannels++;}close(){}},fetch(_route,options){fetchSignal=options.signal;if(!ignoreAbort)return new Promise((resolve,reject)=>{response.then(resolve,reject);fetchSignal.addEventListener('abort',()=>reject(new Error('fixture request aborted')),{once:true});});return response;}},{importModuleDynamically:async()=>{await module.link(()=>{});await module.evaluate();return module;}});
 const ctx={effect(fn){const dispose=fn();if(typeof dispose==='function')disposers.push(dispose);},on(){},slots:{inject(_name,fn){return fn();},register(){return()=>{};}},theme:{getTheme:()=>({preference:'system',fontSize:14,active:{colorScheme:'light'}}),setTheme(value){changes.push(['mode',value]);},setFontSize(value){changes.push(['font',value]);},overrideTokens(){changes.push('tokens');return()=>{};}}};
 return {plugin,ctx,warnings,changes,get signal(){return fetchSignal;},get openedChannels(){return openedChannels;},finish(){resolveResponse({ok:true,json:async()=>({result:{ok:true,value:{revision:1,providers:[],options:{mode:'system',uiSize:18}}}})});},dispose(){for(const dispose of disposers.reverse())dispose();}};
}
test('pending initial status is aborted when appearance unloads without boot rejection',async()=>{
 const fixture=statusFixture();assert.equal(fixture.plugin.apply(fixture.ctx),undefined);await new Promise(setImmediate);assert(fixture.signal);assert.equal(fixture.signal.aborted,false);fixture.dispose();assert.equal(fixture.signal.aborted,true);await new Promise(setImmediate);assert.equal(fixture.warnings.length,0);assert.equal(fixture.openedChannels,0);
});
test('a late status response cannot restore appearance or open a channel after disposal',async()=>{
 const fixture=statusFixture({ignoreAbort:true});fixture.plugin.apply(fixture.ctx);await new Promise(setImmediate);assert(fixture.signal);fixture.dispose();const changes=JSON.stringify(fixture.changes);fixture.finish();await new Promise(setImmediate);assert.equal(JSON.stringify(fixture.changes),changes);assert.equal(fixture.openedChannels,0);assert.equal(fixture.warnings.length,0);
});
