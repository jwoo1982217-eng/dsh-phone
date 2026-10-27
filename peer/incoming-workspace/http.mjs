import path from 'node:path';
import {homedir} from 'node:os';
import {IncomingWorkspaceBroker,incomingServices} from './index.mjs';
const reply=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
const loopback=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
function readJson(req){return new Promise((resolve,reject)=>{let size=0,parts=[],done=false;const timer=setTimeout(()=>finish(Error('来件请求超时')),10000);timer.unref?.();const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);req.removeListener('data',data);req.removeListener('end',end);req.removeListener('error',failed);if(error){req.resume();reject(error);}else resolve(value);};const data=part=>{size+=part.length;if(size>65536){const error=Error('来件请求过大');error.status=413;finish(error);return;}parts.push(part);};const end=()=>{try{const value=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('来件请求无效');finish(null,value);}catch{finish(Error('来件请求格式无效'));}};const failed=()=>finish(Error('来件请求未接收完成'));req.on('data',data);req.once('end',end);req.once('error',failed);});}
/** Same-origin authenticated local endpoint; no service/filesystem action before all admission checks. */
export function registerIncomingWorkspaceRoute(ctx,broker,{origin='http://127.0.0.1:3080'}={}) {
 let pending=0;
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/phone-incoming-workspaces/manage',handler:async(req,res)=>{
  const refused=ctx.connection.requestRejection(req);
  if(refused){req.resume();reply(res,refused,{ok:false,error:'请在已登录的 DSH 中处理来件'});return;}
  if(!loopback(req)||req.method!=='POST'||req.headers.origin!==origin||req.headers.host!==new URL(origin).host||req.headers['content-type']?.split(';')[0].trim()!=='application/json'){
   req.resume();reply(res,403,{ok:false,error:'来件请求来源或格式无效'});return;
  }
  if(Number(req.headers['content-length'])>65536){req.resume();reply(res,413,{ok:false,error:'来件请求过大'});return;}
  if(pending>=2){req.resume();reply(res,409,{ok:false,error:'其他来件正在处理，请稍后重试'});return;}
  pending++;
  try{
   const input=await readJson(req);let value;
   if(input.action==='open')value=await broker.open(input);
   else if(input.action==='prepare')value=await broker.prepare(input);
   else if(input.action==='commit')value=await broker.commit(input.batchId);
   else if(input.action==='cancel')value=await broker.cancel(input.batchId);
   else if(input.action==='status')value=await broker.status(input.batchId);
   else if(input.action==='sweep')value=await broker.sweep();
   else throw Error('来件操作无效');
   if(!res.destroyed)reply(res,200,{ok:true,value});
  }catch(error){if(!res.destroyed)reply(res,error.status??400,{ok:false,error:error.code?'来件文件状态已变化或未处理完成，请重试':error.message??'来件操作失败'});}
  finally{pending--;}
 }}));
}
/** Root calls this only for the phone role, passing the existing ChatFiles instance. */
export function applyIncomingWorkspaces(ctx,files,{home=process.env.DSH_HOME||path.join(homedir(),'.dsh')}={}) {
 return ctx.inject(['sessions','sessionController','sessionPersistence','sessionQuery','workspaceRegistry'],services=>{
  const broker=new IncomingWorkspaceBroker({home,files,services:incomingServices(services)});
  registerIncomingWorkspaceRoute(services,broker);
  services.effect(()=>{
   const sweep=()=>{void broker.sweep().catch(()=>{});};
   const initial=setTimeout(sweep,10000),timer=setInterval(sweep,6*60*60*1000);
   initial.unref?.();timer.unref?.();
   return ()=>{clearTimeout(initial);clearInterval(timer);};
  });
 });
}
