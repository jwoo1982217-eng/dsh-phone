import {createServer} from 'node:http';
import {networkInterfaces} from 'node:os';
import {randomBytes} from 'node:crypto';
import {pipeline} from 'node:stream/promises';

function lanAddress() {
  const entries=Object.entries(networkInterfaces()).sort(([a],[b])=>Number(!/^(wlan|en|eth)/.test(a))-Number(!/^(wlan|en|eth)/.test(b)));
  for(const [,addresses] of entries)for(const item of addresses??[]){
    const a=item.address.split('.').map(Number);
    if((item.family==='IPv4'||item.family===4)&&!item.internal
      &&(a[0]===10||a[0]===192&&a[1]===168||a[0]===172&&a[1]>=16&&a[1]<=31))return item.address;
  }
}
const escapeLeaf=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());

// A short-lived bearer grants read access to exactly one uploaded file.
// The listener binds one private LAN interface, never a public/all-interface address.
export class AnalysisFileShare {
  constructor(files,{enabled=process.env.DSH_PHONE_ANDROID==='1',address,now=Date.now,ttl=60*60*1000}={}){
    this.files=files;this.enabled=enabled;this.address=address;this.now=now;this.ttl=ttl;
    this.grants=new Map();this.pending=0;this.server=null;this.ready=null;this.closed=false;
  }
  async create(meta){
    if(!this.enabled||this.closed)return;
    for(const [token,grant] of this.grants)if(grant.expires<=this.now())this.grants.delete(token);
    const address=this.address??lanAddress();if(!address)return;
    if(!this.ready){
      this.server=createServer((req,res)=>{void this.handle(req,res);});
      this.server.headersTimeout=10000;this.server.requestTimeout=15000;
      this.ready=new Promise((resolve,reject)=>{
        this.server.once('error',reject);this.server.listen(0,address,()=>resolve());
      });
      this.server.unref();
    }
    try{await this.ready;}catch(error){this.ready=null;this.server=null;throw error;}
    if(this.closed)return;
    if(this.grants.size>=256)this.grants.delete(this.grants.keys().next().value);
    const token=randomBytes(32).toString('hex'),expires=this.now()+this.ttl;
    this.grants.set(token,{path:meta.path,name:meta.name,size:meta.size,sha256:meta.sha256,expires});
    const bound=this.server.address();
    return {url:`http://${bound.address}:${bound.port}/file/${token}/${escapeLeaf(meta.name)}`,expiresAt:new Date(expires).toISOString()};
  }
  async handle(req,res){
    let opened;
    try{
      res.setHeader('cache-control','no-store');
      res.setHeader('x-content-type-options','nosniff');
      const pathname=new URL(req.url,'http://localhost').pathname;
      const match=/^\/file\/([a-f0-9]{64})\/([^/]+)$/.exec(pathname),grant=match&&this.grants.get(match[1]);
      if(!grant||grant.expires<=this.now()||decodeURIComponent(match[2])!==grant.name){res.writeHead(404).end();return;}
      if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{allow:'GET, HEAD'}).end();return;}
      if(this.pending>=2){res.writeHead(429).end();return;}
      this.pending++;
      try{
        opened=await this.files.openFile(grant.path);
        const {handle,stat}=opened;if(stat.size!==grant.size){res.writeHead(409).end();return;}
        let start=0,end=stat.size-1,status=200;
        if(req.headers.range){
          const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
          if(!range){res.writeHead(416).end();return;}
          start=Number(range[1]);end=range[2]?Number(range[2]):end;
          if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=stat.size){res.writeHead(416,{'content-range':`bytes */${stat.size}`}).end();return;}
          status=206;res.setHeader('content-range',`bytes ${start}-${end}/${stat.size}`);
        }
        const length=stat.size===0?0:end-start+1;
        res.writeHead(status,{'content-type':'application/octet-stream','content-length':length,'accept-ranges':'bytes',
          'content-disposition':`attachment; filename*=UTF-8''${escapeLeaf(grant.name)}`,'x-dsh-file-sha256':grant.sha256});
        if(req.method==='HEAD'||!length){res.end();return;}
        await pipeline(handle.createReadStream({start,end,autoClose:false}),res);
      }finally{try{await opened?.handle.close();}finally{this.pending--;}}
    }catch{
      if(!res.headersSent)res.writeHead(404).end();else res.destroy();
    }
  }
  async close(){
    this.closed=true;this.grants.clear();
    if(this.server){this.server.closeAllConnections();await new Promise(resolve=>this.server.close(()=>resolve()));}
  }
}
