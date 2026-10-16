import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,unlink,symlink,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {ChatFiles} from './index.mjs';
import {AnalysisFileShare} from './share.mjs';
async function fixture(options={}){
  const home=await mkdtemp(path.join(tmpdir(),'dsh-file-share-'));
  const files=new ChatFiles(home),share=new AnalysisFileShare(files,{enabled:true,address:'127.0.0.1',...options});
  return {home,files,share,close:async()=>{await share.close();await rm(home,{recursive:true,force:true});}};
}
test('temporary single-file bridge preserves original Unicode/ZIP bytes and byte ranges',async()=>{
  const f=await fixture();try{
    const bytes=Buffer.from('中文😀完整原文'.repeat(40000)),meta=await f.files.upload(Readable.from([bytes]),"中文 !'()* 文件.zip");
    const grant=await f.share.create(meta),r=await fetch(grant.url);
    assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);assert.equal(r.headers.get('x-dsh-file-sha256'),meta.sha256);
    assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('accept-ranges'),'bytes');
    const head=await fetch(grant.url,{method:'HEAD'});assert.equal(head.headers.get('content-length'),String(bytes.length));assert.equal((await head.arrayBuffer()).byteLength,0);
    const range=await fetch(grant.url,{headers:{range:'bytes=8001-9000'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(8001,9001));
    const tail=await fetch(grant.url,{headers:{range:`bytes=${bytes.length-17}-`}});assert.deepEqual(Buffer.from(await tail.arrayBuffer()),bytes.subarray(-17));
    const diskMeta=JSON.parse(await readFile(path.join(f.files.root,meta.id,'meta.json'),'utf8'));assert.equal(diskMeta.downloadUrl,undefined);
  }finally{await f.close();}
});
test('wrong capability/name/method/range and expired grants never release file contents',async()=>{
  let now=Date.now();const f=await fixture({now:()=>now,ttl:1000});try{
    const meta=await f.files.upload(Readable.from(['PRIVATE_QA_BYTES']),'analysis.json'),grant=await f.share.create(meta);
    const bad=new URL(grant.url);bad.pathname=bad.pathname.replace(/\/file\/[a-f0-9]{64}\//,'/file/'+'0'.repeat(64)+'/');
    assert.equal((await fetch(bad)).status,404);assert.equal((await fetch(grant.url+'wrong')).status,404);
    assert.equal((await fetch(grant.url,{method:'POST'})).status,405);
    for(const range of ['bytes=-1','bytes=4-2','bytes=0-999','bytes=0-1,2-3'])assert.equal((await fetch(grant.url,{headers:{range}})).status,416);
    now+=1001;const expired=await fetch(grant.url);assert.equal(expired.status,404);assert.equal(await expired.text(),'');
  }finally{await f.close();}
});
test('file substitution is rejected and a later valid upload recovers; disposal removes grants',async()=>{
  const f=await fixture();try{
    const meta=await f.files.upload(Readable.from(['safe']),'safe.txt'),grant=await f.share.create(meta);
    await unlink(meta.path);const outside=path.join(f.home,'outside');await writeFile(outside,'UNRELATED_PRIVATE');await symlink(outside,meta.path);
    const rejected=await fetch(grant.url);assert.equal(rejected.status,404);assert.equal(await rejected.text(),'');assert.equal(f.share.pending,0);
    const good=await f.files.upload(Readable.from(['recovered']),'retry.txt'),retry=await f.share.create(good);assert.equal(await (await fetch(retry.url)).text(),'recovered');
    await f.share.close();assert.equal(f.share.grants.size,0);assert.equal(await f.share.create(good),undefined);
  }finally{await f.close();}
});
test('empty files work, disabled bridge opens no listener, bind failure can retry',async()=>{
  const f=await fixture();try{
    const empty=await f.files.upload(Readable.from([]),'empty.json'),grant=await f.share.create(empty);assert.equal(await (await fetch(grant.url)).text(),'');
    const disabled=new AnalysisFileShare(f.files,{enabled:false});assert.equal(await disabled.create(empty),undefined);assert.equal(disabled.server,null);await disabled.close();
    const retry=new AnalysisFileShare(f.files,{enabled:true,address:'203.0.113.1'});try{await assert.rejects(retry.create(empty));retry.address='127.0.0.1';const recovered=await retry.create(empty);assert.equal((await fetch(recovered.url)).status,200);}finally{await retry.close();}
  }finally{await f.close();}
});
