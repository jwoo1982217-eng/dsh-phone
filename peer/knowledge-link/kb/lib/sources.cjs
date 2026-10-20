'use strict';
const zlib = require('node:zlib');
const { fs, path, hash, walk } = require('./util.cjs');
const SKIP = new Set(['node_modules','plugins','attachments','attachment','tmp','build','dist']);
function discover(c, kind) {
  const files = [], warnings = [], missing = [];
  if (!kind || kind==='md') for (const source of c.sources) {
    if (!fs.existsSync(source.path)) { warnings.push(`资料目录不存在：${source.path}`);missing.push(source.path);continue; }
    for (const file of walk(source.path,n=>n.endsWith('.md'),SKIP)) {
      const rel=path.relative(source.path,file).split(path.sep).join('/');
      if (fs.statSync(file).size>c.maxFileBytes) { warnings.push(`超出 maxFileBytes，未索引：${file}`); continue; }
      const parts=rel.split('/');
      const cat=parts.length===1?'root':parts[0];
      files.push({id:'md:'+file,file,relative:source.name+'/'+rel,kind:'md',source:source.name,cat,sub:parts.length>2?parts[1]:''});
    }
  }
  if (!kind || kind==='session') for (const root of c.sessionsRoots) {
    if(!fs.existsSync(root)){warnings.push(`会话根目录不存在：${root}`);missing.push(root);continue;}
    for (const branch of ['sessions','session-quarantine']) {
      const dirs=new Map();
      for (const file of walk(path.join(root,branch),n=>/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(n))) {
        const dir=path.dirname(file), ver=Number(path.basename(file).match(/\.v(\d+)/)?.[1]||0);
        const old=dirs.get(dir);
        if (!old || ver>old.ver) dirs.set(dir,{file,ver});
      }
      for (const {file} of dirs.values()) files.push({id:'session:'+file,file,relative:path.relative(root,file),kind:'session',source:'dsh',cat:'session',sub:branch,sid:path.basename(path.dirname(file))});
    }
  }
  return { files:files.sort((a,b)=>a.id.localeCompare(b.id)), warnings, missing };
}
function splitText(text, c) {
  const out=[]; let pos=0;
  while (pos<text.length) {
    let end=Math.min(pos+c.chunkSize,text.length);
    if (end<text.length) { const br=text.slice(pos,end).lastIndexOf('\n'); if (br>c.chunkSize/2) end=pos+br+1; }
    // Do not split a UTF-16 surrogate pair.
    if (end<text.length && /[\uD800-\uDBFF]/.test(text[end-1])) end--;
    if (text.slice(pos,end).trim()) out.push({text:text.slice(pos,end),start:pos,end});
    if (end===text.length) break;
    const next=Math.max(pos+1,end-c.overlap);pos=(/[\uDC00-\uDFFF]/.test(text[next])?next+1:next);
  }
  return out;
}
function decodeFrames(buf, file='') {
  if (typeof zlib.zstdDecompressSync!=='function') throw new Error('会话解压需要 Node >=22.15，推荐 Node 24 LTS');
  let off=0, pieces=[], warnings=[];
  while(off<buf.length) {
    try {
      const frame=require('./zstd.cjs').frameEnd(buf,off);
      if(frame.skip){off=frame.end;continue;}
      const result=zlib.zstdDecompressSync(buf.subarray(off,frame.end),{info:true,maxOutputLength:256*1024*1024});
      const used=result.engine.bytesWritten;
      if (used!==frame.end-off) throw new Error('解压器消费长度与帧边界不同');
      if(frame.contentSize!==undefined && BigInt(result.buffer.length)!==frame.contentSize)throw new Error('解压输出长度与帧头不一致');
      pieces.push(result.buffer);off+=used;
    } catch(e) {
      // A live writer may leave a partial final frame. Never resync inside compressed payload.
      if (off===0) throw new Error(`会话无法解压 ${file}: ${e.message}`);
      warnings.push(`会话偏移 ${off} 后有不完整或损坏数据，保留此前完整帧：${file}`);break;
    }
  }
  return {text:Buffer.concat(pieces).toString('utf8'),warnings,consumed:off};
}
function textContent(content) {
  if(typeof content==='string') return content;
  if(!Array.isArray(content)) return '';
  return content.filter(b=>b?.type==='text').map(b=>b.text||'').join('\n');
}
function sessionRows(text, source, c) {
  let rows=[],turn=[],meta={sid:source.sid},warnings=[],count=0,messages=[];
  const flush=()=>{
    if(!turn.length)return;
    const full=turn.map(x=>`${x.role==='user'?'用户':'助手'}：${x.text}`).join('\n');
    const chunks=splitText(full,c);
    for(const part of chunks)rows.push({...source,...meta,text:part.text,turn:count,time:turn[0].time,seqStart:turn[0].seq,seqEnd:turn.at(-1).seq,lineStart:turn[0].line,lineEnd:turn.at(-1).line,roles:[...new Set(turn.map(x=>x.role))]});
    turn=[];count++;
  };
  let line=0;
  for(const raw of text.split('\n')) {
    line++;if(!raw.trim())continue;
    let j;try{j=JSON.parse(raw);}catch{warnings.push(`会话 JSON 第 ${line} 行损坏：${source.file}`);continue;}
    if(j.type==='session') {meta.sid=j.id||source.sid;meta.cwd=j.cwd;continue;}
    const d=j.data||{};
    if(j.type==='user/message') {
      const origin=d.source?.kind;
      if(origin && !['user','bot'].includes(origin))continue;
      const value=textContent(d.content);if(!value.trim())continue;
      flush();const message={role:'user',text:value,time:j.time,seq:j.seq,line};turn.push(message);messages.push(message);
    } else if(j.type==='assistant/message' && d.message?.role==='assistant') {
      const value=textContent(d.message.content);if(value.trim()){const message={role:'assistant',text:value,time:j.time,seq:j.seq,line};turn.push(message);messages.push(message);}
    }
  }
  flush();return {rows,warnings,messages:messages.map(m=>({...source,...meta,text:m.text,time:m.time,role:m.role,lineStart:m.line,lineEnd:m.line,seqStart:m.seq,seqEnd:m.seq}))};
}
function readSource(source,c) {
  const st=fs.statSync(source.file),buf=fs.readFileSync(source.file),after=fs.statSync(source.file);
  if(st.size!==after.size || st.mtimeMs!==after.mtimeMs)throw new Error(`读取期间文件变化，请重试：${source.file}`);
  const fingerprint=hash(buf);
  if(source.kind==='session') {
    const decoded=source.file.endsWith('.zstd')?decodeFrames(buf,source.file):{text:buf.toString('utf8'),warnings:[]};
    const parsed=sessionRows(decoded.text,source,c);
    return {...parsed,warnings:[...decoded.warnings,...parsed.warnings],fingerprint,mtime:st.mtimeMs,size:st.size};
  }
  const text=buf.toString('utf8'), newline=[];for(let i=0;i<text.length;i++)if(text[i]==='\n')newline.push(i);
  const lineAt=offset=>{let lo=0,hi=newline.length;while(lo<hi){const mid=(lo+hi)>>1;if(newline[mid]<offset)lo=mid+1;else hi=mid;}return lo+1;};
  return {rows:splitText(text,c).map((part,i)=>({...source,text:part.text,chunk:i+1,lineStart:lineAt(part.start),lineEnd:lineAt(part.end-1)})),fingerprint,mtime:st.mtimeMs,size:st.size,warnings:[]};
}
module.exports={discover,splitText,decodeFrames,textContent,sessionRows,readSource};
