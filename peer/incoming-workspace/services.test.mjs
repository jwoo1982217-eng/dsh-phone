import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
import Sessions,{Session} from '@deepseek-ai/dsh-session';
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import {incomingServices} from './protection.mjs';

async function actualSdk(t,resolver){
 const {Context:SdkContext}=await import(pathToFileURL(resolver.resolve('@deepseek-ai/cordis'))),{default:SdkSessions,Session:SdkSession}=await import(pathToFileURL(resolver.resolve('@deepseek-ai/dsh-session'))),PersistenceModule=await import(pathToFileURL(resolver.resolve('@deepseek-ai/dsh-session-persistence-jsonl')));
 const home=await mkdtemp(path.join(tmpdir(),'dsh-incoming-sdk-')),ctx=new SdkContext();
 t.after(async()=>{await ctx.fiber.dispose();await rm(home,{recursive:true,force:true});});
 await ctx.plugin(SdkSessions);await ctx.plugin(PersistenceModule.default??PersistenceModule,{root:path.join(home,'sessions'),compression:'none'});
 let source=await readFile(resolver.resolve('@deepseek-ai/dsh-api-session-controller'),'utf8');
 source=source.replace(/from "([^"]+)"/g,(_full,specifier)=>'from '+JSON.stringify(specifier.startsWith('node:')?specifier:pathToFileURL(resolver.resolve(specifier)).href));
 // Expose only the unexported command class in this private in-memory test module, not product source.
 const {SessionCommandController,SessionController}=await import('data:text/javascript;base64,'+Buffer.from(source+'\nexport {SessionCommandController};').toString('base64'));
 const requests=[],workspace={id:'workspace-fixture',path:home,sessionIds:[],async attachSession(id){if(!this.sessionIds.includes(id))this.sessionIds.push(id);}};
 const sdkCtx={workspaceRegistry:{get:id=>id===workspace.id?workspace:undefined,archivedSessionIds:[]}};
 const agents={async ensureSession(id,cwd,explicit){requests.push({id,cwd,explicit});let stored=await ctx.sessionPersistence.stat(id);if(!stored){const handle=await ctx.sessionPersistence.create({version:4,id,createdAt:1,isSeeded:false,cwd});await handle.flush();await handle.close();stored=await ctx.sessionPersistence.stat(id);}return {session:SdkSession.create(id,undefined,stored.header)};},presetForSession:()=>undefined};
 agents.createSession=async request=>{const value=await agents.ensureSession(request.sessionId,request.cwd,true);return {agent:{id:request.sessionId,...value}};};
 const commands=new SessionCommandController(sdkCtx,agents,home),controller=Object.create(SessionController.prototype);controller.commands=commands;
 const adapter=incomingServices({sessionController:controller,sessionPersistence:ctx.sessionPersistence,sessions:ctx.sessions,workspaceRegistry:sdkCtx.workspaceRegistry});
 const input={workspaceId:workspace.id,sessionId:'session-incoming-'+'a'.repeat(32)};
 assert.deepEqual(await adapter.createSession(input),{sessionId:input.sessionId});assert.deepEqual(await adapter.createSession(input),{sessionId:input.sessionId});
 const stored=await ctx.sessionPersistence.list();assert.equal(stored.length,1);assert.equal(stored[0].header.cwd,home);assert.deepEqual(workspace.sessionIds,[input.sessionId]);assert(requests.every(x=>x.explicit));
 const handle=await ctx.sessionPersistence.open(input.sessionId,'read');try{assert.deepEqual((await handle.read()).events,[]);}finally{await handle.close();}
}
test('adapter delegates actual published Session create commands and JSONL durability without any prompt or user event',t=>actualSdk(t,createRequire(import.meta.url)));
if(process.env.DSH_INCOMING_RC2_NODE_MODULES)test('actual rc2 command and JSONL adapter keep one durable blank identity on retry',t=>actualSdk(t,createRequire(path.join(process.env.DSH_INCOMING_RC2_NODE_MODULES,'../fixture.cjs'))));
test('protection adapter reads all durable/live records and preserves complete raw event references',async()=>{
 const calls=[];const ctx={sessionController:{list:async()=>({items:[{running:false}]})},sessionQuery:{listSessions:async()=>[{header:{id:'a',cwd:'/ordinary'}},{header:{id:'b',cwd:'/incoming'}}],readSession:async id=>{calls.push(id);return {events:[{path:'/incoming/file'}]};}},workspaceRegistry:{pinnedSessionIds:['b'],list:()=>[{id:'w',path:'/incoming'}]}};
 const value=await incomingServices(ctx).protection();assert.deepEqual(calls,['a','b']);assert.deepEqual(value.pinnedIds,['b']);assert.equal(value.headers.length,2);assert.equal(value.events.length,2);
 ctx.sessionQuery.readSession=async()=>{throw Error('unreadable retained log');};await assert.rejects(incomingServices(ctx).protection(),/unreadable/);
});
test('existing started session is adopted without calling rc2 new-conversation create again',async()=>{
 const id='session-incoming-'+'b'.repeat(32),header={id,cwd:'/owned/incoming'},calls=[];
 const workspace={id:'w',path:header.cwd,attachSession:async value=>calls.push(['attach',value])};
 const ctx={sessions:{get:()=>({header})},sessionPersistence:{flush:async()=>calls.push(['flush']),stat:async()=>({header})},workspaceRegistry:{get:()=>workspace},sessionController:{create:async()=>{calls.push(['create']);return {sessionId:'unexpected-new-id'};}}};
 assert.deepEqual(await incomingServices(ctx).createSession({workspaceId:'w',sessionId:id}),{sessionId:id});assert.deepEqual(calls,[['attach',id],['flush']]);
});
