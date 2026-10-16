'use strict';
const crypto = require('node:crypto');
const {fs,path,hash,mkdir,json,writeJson,atomic,lock}=require('./util.cjs');
function current(c) {
  const pointer=path.join(c.dataDir,'CURRENT');
  if(!fs.existsSync(pointer))return null;
  const id=fs.readFileSync(pointer,'utf8').trim();
  if(!/^[a-zA-Z0-9-]+$/.test(id))throw new Error('CURRENT 索引指针不合法');
  const dir=path.join(c.dataDir,'generations',id),manifest=json(path.join(dir,'manifest.json'));
  if(manifest.version!==3)throw new Error('索引版本不支持');
  return {id,dir,manifest};
}
function floats(vectors,dim) {
  const out=Buffer.alloc(vectors.length*dim*4);
  vectors.forEach((v,i)=>{
    if(!Array.isArray(v)||v.length!==dim||v.some(n=>!Number.isFinite(n)))throw new Error('向量维度或数值不合法');
    let norm=0;for(const x of v)norm+=x*x;if(!norm)throw new Error('零向量不能建库');
    v.forEach((x,j)=>out.writeFloatLE(x,(i*dim+j)*4));
  });return out;
}
function* shardRows(dir,shard,dim) {
  const text=fs.readFileSync(path.join(dir,shard.text)),bin=fs.readFileSync(path.join(dir,shard.bin));
  if(hash(text)!==shard.textHash||hash(bin)!==shard.binHash)throw new Error('索引分片校验失败；原始资料未改动，请重建索引');
  const rows=text.toString('utf8').trim()?text.toString('utf8').trimEnd().split('\n').map(JSON.parse):[];
  if(rows.length!==shard.count||bin.length!==rows.length*dim*4)throw new Error('索引文本与向量数量不一致');
  for(let i=0;i<rows.length;i++)yield {row:rows[i],bin,offset:i*dim*4};
}
function cacheKey(source,content,c) {return hash(source.id+'\0'+content.fingerprint+'\0'+c.signature);}
function cached(c,key) {
  const dir=path.join(c.dataDir,'cache',key);
  if(!fs.existsSync(path.join(dir,'cache.json')))return null;
  const meta=json(path.join(dir,'cache.json'));
  // Verify before reuse; corrupted cache must never replace a working generation.
  [...shardRows(dir,meta.shard,meta.dim)];
  return {...meta,dir,key};
}
function writeCache(c,key,source,content,vectors,dim) {
  const parent=path.join(c.dataDir,'cache');mkdir(parent);
  const final=path.join(parent,key),dir=path.join(parent,'.tmp-'+crypto.randomUUID());mkdir(dir);
  try {
    const text=content.rows.map(r=>JSON.stringify({...r,mtime:content.mtime})).join('\n')+(content.rows.length?'\n':'');
    const bin=floats(vectors,dim);
    atomic(path.join(dir,'rows.jsonl'),text);atomic(path.join(dir,'vectors.bin'),bin);
    const shard={text:'rows.jsonl',bin:'vectors.bin',count:content.rows.length,textHash:hash(text),binHash:hash(bin)};
    const meta={source,fingerprint:content.fingerprint,size:content.size,mtime:content.mtime,warnings:content.warnings,dim,shard};
    writeJson(path.join(dir,'cache.json'),meta);fs.renameSync(dir,final);return {...meta,dir:final,key};
  }catch(e){fs.rmSync(dir,{recursive:true,force:true});throw e;}
}
function commit(c,caches,dim,warnings=[],failpoint) {
  const parent=path.join(c.dataDir,'generations');mkdir(parent);
  const id=Date.now()+'-'+crypto.randomUUID(),dir=path.join(parent,id);mkdir(dir);
  let rows=[],vectors=[],shards=[],cats={},sources=[];
  const flush=()=>{
    if(!rows.length)return;
    const name='shard-'+String(shards.length).padStart(4,'0');
    const text=rows.map(JSON.stringify).join('\n')+'\n',bin=Buffer.concat(vectors);
    atomic(path.join(dir,name+'.jsonl'),text);atomic(path.join(dir,name+'.bin'),bin);
    shards.push({text:name+'.jsonl',bin:name+'.bin',count:rows.length,bytes:Buffer.byteLength(text)+bin.length,textHash:hash(text),binHash:hash(bin)});rows=[];vectors=[];
  };
  try {
    for(const cache of caches) {
      if(cache.dim!==dim && cache.shard.count)throw new Error('索引不能混合不同维度的向量');
      sources.push({...cache.source,fingerprint:cache.fingerprint,mtime:cache.mtime,size:cache.size,count:cache.shard.count,key:cache.key,warnings:cache.warnings});
      for(const {row,bin,offset}of shardRows(cache.dir,cache.shard,dim)) {
        rows.push(row);vectors.push(Buffer.from(bin.subarray(offset,offset+dim*4)));
        cats[row.cat]=(cats[row.cat]||0)+1;if(rows.length>=c.shardSize)flush();
      }
    }
    flush();
    const manifest={version:3,createdAt:new Date().toISOString(),model:c.model,revision:c.revision,pooling:c.pooling,signature:c.signature,dim,shardSize:c.shardSize,count:shards.reduce((s,x)=>s+x.count,0),shards,sources,cats,warnings};
    writeJson(path.join(dir,'manifest.json'),manifest);
    // All shards are complete and verified before switching the single commit point.
    for(const shard of shards)for(const _ of shardRows(dir,shard,dim)){}
    failpoint?.('before-publish');
    const old=current(c);
    if(old)atomic(path.join(c.dataDir,'PREVIOUS'),old.id+'\n');
    atomic(path.join(c.dataDir,'CURRENT'),id+'\n');return {id,manifest};
  }catch(e){fs.rmSync(dir,{recursive:true,force:true});throw e;}
}
async function build(c,kind,embed,{log=()=>{},failpoint,force=false}={}) {
  const {discover,readSource}=require('./sources.cjs');
  const release=lock(c.dataDir);
  try {
    const old=current(c),found=discover(c,kind);
    if(found.missing.length)throw new Error('资料根目录不可用，保留原索引：'+found.missing.join(', '));
    let warnings=found.warnings,caches=[],changed=0,reused=0,dim=old?.manifest.dim||512,embedded=0,reusedChunks=0;
    if(old && old.manifest.signature!==c.signature && kind && old.manifest.sources.some(s=>s.kind!==kind))throw new Error('模型或分块配置已变化，请运行 index 重建两路索引');
    if(old && kind)for(const s of old.manifest.sources.filter(s=>s.kind!==kind)){const v=cached(c,s.key);if(!v)throw new Error('缺少另一类索引缓存，请运行 index 重建');caches.push(v);}
    for(const source of found.files) {
      const content=readSource(source,c),key=cacheKey(source,content,c);
      warnings.push(...content.warnings);
      let cache;
      try{cache=cached(c,key);}catch(e){
        if(!force)throw new Error(e.message+'；可运行 index --force 隔离损坏缓存并重建');
        fs.renameSync(path.join(c.dataDir,'cache',key),path.join(c.dataDir,'cache','.corrupt-'+key+'-'+crypto.randomUUID()));cache=null;
      }
      if(cache){reused++;}else{
        const prior=old?.manifest.signature===c.signature?old.manifest.sources.find(s=>s.id===source.id):null;
        const reusable=new Map();
        if(prior){const priorCache=cached(c,prior.key);if(priorCache)for(const {row,bin,offset}of shardRows(priorCache.dir,priorCache.shard,priorCache.dim))reusable.set(hash(row.text),Array.from({length:priorCache.dim},(_,j)=>bin.readFloatLE(offset+j*4)));}
        const vectors=new Array(content.rows.length),pending=new Map();
        content.rows.forEach((row,i)=>{const key=hash(row.text);if(reusable.has(key)){vectors[i]=reusable.get(key);reusedChunks++;}else{if(!pending.has(key))pending.set(key,{text:row.text,indices:[]});pending.get(key).indices.push(i);}});
        const work=[...pending.values()],fresh=work.length?await embed(work.map(x=>x.text),'document'):[];
        if(fresh.length!==work.length)throw new Error('向量结果数量不匹配');
        work.forEach((w,i)=>w.indices.forEach(j=>{vectors[j]=fresh[i];}));embedded+=work.length;
        if(content.rows.length){if(vectors.length!==content.rows.length)throw new Error('向量结果数量不匹配');dim=vectors[0]?.length;if(!dim)throw new Error('向量结果为空');}
        cache=writeCache(c,key,source,content,vectors,dim);changed++;
      }
      caches.push(cache);log(`${changed+reused}/${found.files.length} ${source.relative} (${cache.shard.count})`);
      failpoint?.('after-source');
    }
    if(!found.files.length && warnings.length)throw new Error(warnings.join('\n'));
    const keys=caches.map(x=>x.key).sort();
    let intact=true;
    if(old)try{for(const shard of old.manifest.shards)for(const _of of shardRows(old.dir,shard,old.manifest.dim)){};}catch{intact=false;}
    if(intact && old && old.manifest.signature===c.signature && old.manifest.shardSize===c.shardSize && JSON.stringify(keys)===JSON.stringify(old.manifest.sources.map(x=>x.key).sort()) && JSON.stringify([...new Set(warnings)])===JSON.stringify(old.manifest.warnings))return {id:old.id,manifest:old.manifest,changed,reused,embedded,reusedChunks,noOp:true};
    const result=commit(c,caches,dim,[...new Set(warnings)],failpoint);return {...result,changed,reused,embedded,reusedChunks};
  }finally{release();}
}
function rollback(c) {
  const release=lock(c.dataDir);
  try {
    const previous=fs.readFileSync(path.join(c.dataDir,'PREVIOUS'),'utf8').trim();
    if(!/^[a-zA-Z0-9-]+$/.test(previous))throw new Error('PREVIOUS 指针不合法');
    let now;try{now=current(c);}catch{}
    const dir=path.join(c.dataDir,'generations',previous),mf=json(path.join(dir,'manifest.json'));
    if(mf.signature!==c.signature)throw new Error('上一代使用不同模型或分块配置，恢复对应配置后再回退');
    for(const shard of mf.shards)for(const _of of shardRows(dir,shard,mf.dim)){}
    atomic(path.join(c.dataDir,'CURRENT'),previous+'\n');if(now)atomic(path.join(c.dataDir,'PREVIOUS'),now.id+'\n');return previous;
  }finally{release();}
}
module.exports={current,floats,shardRows,cacheKey,cached,writeCache,commit,build,rollback};
