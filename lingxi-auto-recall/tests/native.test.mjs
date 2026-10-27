import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createRequire} from 'node:module';import {fileURLToPath,pathToFileURL} from 'node:url';import {randomUUID} from 'node:crypto';
import * as RecallPlugin from '../index.mjs';
import {Notes} from '../../knowledge-workbench/src/notes.js';
const root=fileURLToPath(new URL('../../',import.meta.url)),runtime=process.env.DSH_RECALL_TEST_RUNTIME||path.join(root,'desktop-runtime'),require=createRequire(path.join(runtime,'package.json')),load=async n=>import(pathToFileURL(require.resolve(n)));
const {Context}=await load('@deepseek-ai/cordis'),{default:Sessions}=await load('@deepseek-ai/dsh-session'),{default:Projections}=await load('@deepseek-ai/dsh-session-projection'),{default:Agents}=await load('@deepseek-ai/dsh-agent'),{default:SystemPrompt}=await load('@deepseek-ai/dsh-system-prompt'),{default:Tools}=await load('@deepseek-ai/dsh-tools'),{default:Loop}=await load('@deepseek-ai/dsh-agent-loop'),{default:Llm,LlmAdapter,createUserMessage}=await load('@deepseek-ai/dsh-llm');

test('actual SDK ordinary question receives knowledge before model, off/unrelated/recovery preserve base context',async t=>{
 const home=fs.realpathSync(fs.mkdtempSync(path.join(process.env.DSH_RECALL_TEST_ROOT||os.tmpdir(),'native lingxi '))),oldHome=process.env.DSH_HOME;process.env.DSH_HOME=home;fs.mkdirSync(path.join(home,'profiles/phone'),{recursive:true});fs.writeFileSync(path.join(home,'profiles/phone/package.json'),'{}');fs.symlinkSync(path.join(runtime,'node_modules'),path.join(home,'profiles/phone/node_modules'));
 const notes=new Notes(home),nonce='private-fixture-'+randomUUID();notes.save({title:'仓库打包约定',body:'仓库打包约定：验证暗号为 '+nonce+'；模板 {{page}} 保持字面值。',kind:'knowledge'});const before=fs.readFileSync(notes.store.file);
 const ctx=new Context(),seen=[],handlers=new Map();let handle;
 t.after(async()=>{await handle?.dispose();await ctx.fiber.dispose();oldHome===undefined?delete process.env.DSH_HOME:process.env.DSH_HOME=oldHome;fs.rmSync(home,{recursive:true,force:true})});
 ctx.provide('connection',{rpc:{handle:(route,fn)=>{handlers.set(route,fn);return()=>handlers.delete(route)}}});ctx.provide('webServer',{register:()=>()=>{}});ctx.provide('dshKnowledgeWorkbench',{notes});
 await ctx.plugin(Llm);class Adapter extends LlmAdapter{async *stream(o){const messages=o.messages.map(m=>(m.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n')),current=messages.filter(s=>s.startsWith('Current runtime context')).at(-1)||o.system||'';seen.push({received:current.includes(nonce),base:current.includes('KEEP-BASE-CONTEXT'),quotedAsData:current.includes('instructionAuthority')});yield {type:'text-delta',index:0,text:current.includes(nonce)?'从本机笔记自动得到暗号':'未带入笔记'};yield {type:'finish',reason:{kind:'stop'}}}}
 ctx.llm.registerAdapter(['qa-lingxi-note'],new Adapter());for(const plugin of [Sessions,Projections,Agents,SystemPrompt,Tools,Loop])await ctx.plugin(plugin);
 ctx.systemPrompt.context({name:'base-context',order:10,text:'KEEP-BASE-CONTEXT'});await ctx.plugin(RecallPlugin);const recall=ctx.get('dshLingxiKnowledgeRecall');assert(recall);assert(handlers.has('/lingxi-recall'));
 handle=await ctx.agents.create({sessionId:'native-lingxi-note-'+randomUUID(),meta:{cwd:home},agentOptions:{provider:'qa-lingxi-note',model:'fixture'}});
 const ask=async value=>{handle.agent.followup(createUserMessage({content:[{type:'text',text:value}],source:{kind:'user'}}));await handle.agent.whenIdle();return seen.at(-1)};
 assert.equal((await ask('仓库打包约定是什么')).received,false);recall.configure({revision:0,enabled:true});
 const related=await ask('仓库打包约定是什么');assert.equal(related.received,true,JSON.stringify(seen));assert.equal(related.base,true);assert.equal(related.quotedAsData,true);
 const unrelated=await ask('今天天气怎么样');assert.equal(unrelated.received,false,JSON.stringify(seen));assert.equal(unrelated.base,true);
 recall.configure({revision:1,enabled:false});assert.equal((await ask('仓库打包约定是什么')).received,false);
 recall.configure({revision:2,enabled:true});assert.equal((await ask('仓库打包约定是什么')).received,true);
 assert.deepEqual(fs.readFileSync(notes.store.file),before);assert.equal(seen.length,5);
 const receipt={sdkVersion:JSON.parse(fs.readFileSync(require.resolve('@deepseek-ai/dsh/package.json'))).version,actualAgentLoop:true,ordinaryQuestionAutomaticallyReceivedLocalNonce:true,unrelatedDidNotReuseOldReference:true,disabledDidNotInject:true,reenabledRecovered:true,originalRuntimeContextPreserved:true,knowledgeBytesUnchanged:true,modelCallsToLocalFixture:seen.length,externalModelCalls:0,explicitMcpCalls:0};
 if(process.env.DSH_RECALL_NATIVE_RECEIPT)fs.writeFileSync(process.env.DSH_RECALL_NATIVE_RECEIPT,JSON.stringify(receipt,null,2));
});
