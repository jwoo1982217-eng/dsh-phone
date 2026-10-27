import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {createHash,createHmac,randomUUID} from 'node:crypto';

// Use the current local DSH session credential; never copy it into MCP config.
export class LocalDsh {
  constructor(home,{port=3080,secret}={}) {
    this.home=home; this.port=Number(port); this.secret=secret;
    if(!Number.isInteger(this.port)||this.port<1||this.port>65535) throw Error('DSH 本机端口无效');
  }
  credential() {
    if(this.secret) return this.secret;
    try {
      const require=createRequire(path.join(this.home,'profiles/phone/package.json'));
      const {parse}=require('yaml');
      const s=parse(fs.readFileSync(path.join(this.home,'.credentials.yaml'),'utf8'));
      const secret=s.records?.['client-connection/browser-session']?.payload?.secret;
      if(typeof secret!=='string'||!secret) throw Error();
      return secret;
    } catch { throw Error('DSH 本机认证或 YAML 运行依赖尚未就绪；未更改凭据'); }
  }
  async manage(route,action,args={},signal) {
    if(!['knowledge-base','knowledge-link'].includes(route)) throw Error('不支持的本机接口');
    signal?.throwIfAborted();
    const authority='127.0.0.1:'+this.port, now=Date.now();
    const payload=Buffer.from(JSON.stringify({version:1,authority,issuedAt:now-10000,expiresAt:now+60000})).toString('base64url');
    const cookie='dsh-auth-'+createHash('sha256').update(authority).digest('base64url')+'=v1.'+payload+'.'+createHmac('sha256',Buffer.from(this.credential(),'base64url')).update(payload).digest('base64url');
    const body=JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'manage',payload:{...args,action}});
    return new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port:this.port,path:'/'+route+'/manage',method:'POST',signal,headers:{host:authority,origin:'http://'+authority,cookie,'content-type':'application/json'}},res=>{
        const chunks=[];let size=0;
        res.on('data',b=>{size+=b.length;if(size>16*1024*1024)req.destroy(Error('本机响应过大'));else chunks.push(b)});
        res.on('error',reject);
        res.on('end',()=>{try{
          if(res.statusCode!==200) throw Error('DSH 本机接口不可用（HTTP '+res.statusCode+'）');
          const r=JSON.parse(Buffer.concat(chunks).toString('utf8')).result;
          if(!r?.ok) throw Error(r?.error?.message||'DSH 本机操作未完成');
          resolve(r.value);
        }catch(e){reject(e)}});
      });
      req.on('error',reject);req.setTimeout(20000,()=>req.destroy(Error('DSH 本机接口超时；写入结果未知，请先查询，不自动重试')));req.end(body);
    });
  }
}
