import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import http from 'node:http';
const require=createRequire(fileURLToPath(new URL('../desktop-runtime/package.json',import.meta.url)));
const {parse}=require('yaml');
export const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export function deviceOptions(args=process.argv.slice(2)){
  const get=k=>args[args.indexOf(k)+1];
  if(!args.includes('--serial'))throw Error('请显式指定 --serial');
  const serial=get('--serial'),port=args.includes('--adb-port')?get('--adb-port'):'5037';
  if(!/^[\w.:-]+$/.test(serial)||!/^\d+$/.test(port))throw Error('设备或 ADB 端口无效');
  return {serial,port,package:'com.dshphone',home:'/data/user/0/com.dshphone/files/dsh-home'};
}
export function adb(d,args,options={}){return execFileSync('adb',['-P',d.port,'-s',d.serial,...args],{maxBuffer:32*1024*1024,timeout:60000,...options})}
export function phoneNode(d,code,timeout=60000){
  const native=adb(d,['shell','run-as',d.package,'readlink','files/bin/node']).toString().trim();
  if(!native.includes('/'+d.package+'-')||!native.endsWith('/libnode.so'))throw Error('当前 Node 不属于目标 DSH');
  const env={HOME:d.home,DSH_HOME:d.home,TMPDIR:path.posix.resolve(d.home,'../tmp'),LD_LIBRARY_PATH:path.posix.dirname(native),OPENSSL_CONF:'/dev/null'};
  const command=Object.entries(env).map(([k,v])=>k+'='+quote(v)).join(' ')+' '+quote(native)+' --input-type=module -';
  return adb(d,['shell','run-as',d.package,'sh','-c',quote(command)],{input:code,timeout}).toString();
}
export async function connect(d){
  const raw=adb(d,['exec-out','run-as',d.package,'cat','files/dsh-home/.credentials.yaml']);
  let secret;try{secret=parse(raw.toString()).records?.['client-connection/browser-session']?.payload?.secret}catch{}
  if(!secret)throw Error('本机认证尚未就绪');
  const port=adb(d,['forward','tcp:0','tcp:3080']).toString().trim(),authority='127.0.0.1:3080';
  const offset=Number(adb(d,['shell','date','+%s']).toString().trim())*1000-Date.now();
  const manage=(route,action,args={})=>new Promise((resolve,reject)=>{
    const now=Date.now()+offset,p=Buffer.from(JSON.stringify({version:1,authority,issuedAt:now-10000,expiresAt:now+60000})).toString('base64url');
    const cookie='dsh-auth-'+createHash('sha256').update(authority).digest('base64url')+'=v1.'+p+'.'+createHmac('sha256',Buffer.from(secret,'base64url')).update(p).digest('base64url');
    const req=http.request({hostname:'127.0.0.1',port,path:'/'+route+'/manage',method:'POST',headers:{host:authority,origin:'http://'+authority,cookie,'content-type':'application/json'}},res=>{
      const chunks=[];let size=0;res.on('data',b=>{size+=b.length;if(size>32*1024*1024)req.destroy(Error('响应过大'));else chunks.push(b)});res.on('error',reject);
      res.on('end',()=>{try{if(res.statusCode!==200)throw Error('DSH '+route+' HTTP '+res.statusCode);const raw=Buffer.concat(chunks);if(!raw.length)throw Error('DSH '+route+' 暂未返回管理数据');const r=JSON.parse(raw).result;if(!r?.ok)throw Error(r?.error?.message||'DSH RPC 拒绝');resolve(r.value)}catch(e){reject(e)}});
    });req.on('error',reject);req.setTimeout(60000,()=>req.destroy(Error('本机管理接口超时；未自动重试')));req.end(JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'manage',payload:{...args,action}}));
  });
  return {manage,close:()=>adb(d,['forward','--remove','tcp:'+port])};
}
