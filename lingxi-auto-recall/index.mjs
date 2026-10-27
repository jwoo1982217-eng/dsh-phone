import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {KnowledgeRecall} from './recall.mjs';
export const name='dsh-lingxi-auto-recall';
export const inject=['systemPrompt','connection','webServer'];
export async function apply(ctx){
  const home=fs.realpathSync(process.env.DSH_HOME||path.join(os.homedir(),'.dsh')),require=createRequire(path.join(home,'profiles/phone/package.json'));
  const {createUserMessage}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
  const recall=new KnowledgeRecall(home,()=>ctx.get('dshKnowledgeWorkbench'),createUserMessage);
  recall.refreshes=()=>typeof ctx.get('systemPrompt')?.refreshContext==='function';
  ctx.provide('dshLingxiKnowledgeRecall',recall);
  ctx.on('agent/pre-step',(payload,next)=>recall.before(payload,next));
  ctx.inject(['systemPrompt'],prompt=>{if(typeof prompt.systemPrompt.refreshContext!=='function')return;prompt.systemPrompt.context({name:'dsh:lingxi-knowledge',order:25,interpolate:false,text:context=>recall.context(context.agent)})});
  ctx.on('dispose',()=>recall.close());
  ctx.connection.rpc.handle('/lingxi-recall',async(method,p)=>{try{if(method!=='manage')throw Error('请求无效');return {ok:true,value:p?.action==='status'?recall.status():p?.action==='configure'?recall.configure(p):(()=>{throw Error('未知操作')})()}}catch(e){return {ok:false,error:{code:'lingxi-recall/failed',message:e.message,details:{}}}}},{authority:'loopback'});
  for(const [route,file,type]of [['/lingxi-recall','page.html','text/html'],['/lingxi-recall/page.js','page.js','text/javascript']]){
    const bytes=fs.readFileSync(new URL(file,import.meta.url));ctx.effect(()=>ctx.webServer.register({kind:'exact',path:route,handler(req,res){if(req.method!=='GET'){res.writeHead(405).end();return}res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'"});res.end(bytes)}}));
  }
}
