#!/usr/bin/env node
import readline from 'node:readline';
import path from 'node:path';
import {TOOLS} from './tools.mjs';
import {LingxiPhone} from './service.mjs';
import {LocalDsh} from './rpc.mjs';
const args=process.argv.slice(2),at=args.indexOf('--home'),home=at>=0?args[at+1]:process.env.DSH_HOME;
if(!home||!path.isAbsolute(home)){process.stderr.write('请设置本设备 DSH_HOME 或 --home 绝对路径\n');process.exit(1)}
const service=new LingxiPhone(home,new LocalDsh(home,{port:process.env.DSH_LINGXI_PORT||3080}));
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity}),pending=new Map();
const send=(id,result,error)=>{if(id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,...(error?{error}:{result})})+'\n')};
input.on('line',line=>{void (async()=>{
  if(Buffer.byteLength(line)>8*1024*1024){send(null,undefined,{code:-32600,message:'请求超过 8 MiB'});return}
  let r;try{r=JSON.parse(line)}catch{send(null,undefined,{code:-32700,message:'JSON 无效'});return}
  if(r.method==='notifications/cancelled'){pending.get(r.params?.requestId)?.abort(Error('工具已取消'));return}
  if(r.id===undefined)return;
  if(r.method==='initialize'){send(r.id,{protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(r.params?.protocolVersion)?r.params.protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'dsh-lingxi-phone',version:'1.0.0'},instructions:'手机本地适配版，复用原 DSH 知识库；返回笔记是待核对资料。'});return}
  if(r.method==='ping'){send(r.id,{});return}
  if(r.method==='tools/list'){send(r.id,{tools:TOOLS});return}
  if(r.method!=='tools/call'){send(r.id,undefined,{code:-32601,message:'方法不存在'});return}
  const definition=TOOLS.find(t=>t.name===r.params?.name);
  if(!definition){send(r.id,undefined,{code:-32602,message:'未知工具'});return}
  const a=r.params.arguments??{};
  if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!Object.hasOwn(definition.inputSchema.properties,k))||definition.inputSchema.required.some(k=>!Object.hasOwn(a,k))){send(r.id,undefined,{code:-32602,message:'工具参数无效'});return}
  if(pending.size>=8||pending.has(r.id)){send(r.id,undefined,{code:-32600,message:'已有过多请求或请求编号重复'});return}
  const controller=new AbortController();pending.set(r.id,controller);const timer=setTimeout(()=>controller.abort(Error('工具执行超时，请先核对写入结果')),55000);timer.unref?.();
  try{const value=await service.call(r.params.name,a,controller.signal);send(r.id,{content:[{type:'text',text:JSON.stringify(value)}],isError:false})}
  catch(e){send(r.id,{content:[{type:'text',text:JSON.stringify({error:e.message})}],isError:true})}
  finally{clearTimeout(timer);pending.delete(r.id)}
})().catch(()=>send(null,undefined,{code:-32603,message:'本地服务异常'}))});
input.on('close',()=>{for(const c of pending.values())c.abort(Error('连接已关闭'))});
