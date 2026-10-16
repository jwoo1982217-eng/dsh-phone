'use strict';
const {current,shardRows}=require('./store.cjs');
const {discover,readSource}=require('./sources.cjs');
const {redact}=require('./redact.cjs');
function terms(text) {
  const lower=text.toLowerCase(),words=lower.match(/[a-z0-9_.:/-]{2,}/g)||[];
  for(const part of lower.match(/[\p{Script=Han}]+/gu)||[])for(let i=0;i<part.length-1;i++)words.push(part.slice(i,i+2));
  return [...new Set(words)];
}
function lexicalScore(text,query) {
  const t=text.toLowerCase(),q=query.toLowerCase(),keys=terms(query);
  if(t.includes(q))return 1;
  if(!keys.length)return 0;
  return keys.filter(k=>t.includes(k)).length/keys.length;
}
function matches(row,opts) {return(!opts.cat||row.cat===opts.cat)&&(!opts.sub||row.sub===opts.sub)&&(!opts.kind||row.kind===opts.kind);}
function topCount(opts) {const n=Number(opts.top||6);if(!Number.isInteger(n)||n<1||n>100)throw new Error('--top 必须为 1..100');return n;}
async function search(c,query,opts={},embed) {
  if(!query.trim())throw new Error('查询不能为空');
  const index=current(c);if(!index)throw new Error('尚未建库，请先运行 index');
  if(index.manifest.signature!==c.signature)throw new Error('模型或分块配置变化，请先运行 index');
  const top=topCount(opts),dim=index.manifest.dim;
  // Corpus-specific term weights keep rare identifiers and project terms useful.
  const keys=terms(query),df=new Map(keys.map(k=>[k,0]));let total=0;
  for(const shard of index.manifest.shards)for(const {row}of shardRows(index.dir,shard,dim))if(matches(row,opts)){total++;const text=row.text.toLowerCase();for(const key of keys)if(text.includes(key))df.set(key,df.get(key)+1);}
  const weights=new Map([...df].filter(([,n])=>n>0).map(([key,n])=>[key,Math.log(1+(total-n+0.5)/(n+0.5))]));
  const weightSum=[...weights.values()].reduce((s,x)=>s+x,0)||1;
  const qv=opts.lexical?null:(await embed([query],'query'))[0];
  if(qv && (qv.length!==dim||qv.some(n=>!Number.isFinite(n))))throw new Error('查询向量与索引维度不一致');
  const qn=qv?Math.sqrt(qv.reduce((s,x)=>s+x*x,0)):1;
  if(!qn)throw new Error('查询向量不能为零');
  let best=[];
  for(const shard of index.manifest.shards)for(const {row,bin,offset}of shardRows(index.dir,shard,dim)) {
    if(!matches(row,opts))continue;
    const text=row.text.toLowerCase();
    const lexical=text.includes(query.toLowerCase())?1:[...weights].reduce((s,[key,w])=>s+(text.includes(key)?w:0),0)/weightSum;let cosine=0;
    if(qv){let dot=0,norm=0;for(let j=0;j<dim;j++){const v=bin.readFloatLE(offset+j*4);dot+=v*qv[j];norm+=v*v;}cosine=dot/((Math.sqrt(norm)||1)*qn);}
    if(opts.lexical?!lexical:cosine<0.30&&!lexical)continue;
    const age=Math.max(0,(Date.now()-(row.time||row.mtime||0))/86400000);
    const score=opts.lexical?lexical:cosine+0.4*lexical+0.03*Math.exp(-age/90);
    best.push({...row,score,cosine,lexical,untrusted:true});
    best.sort((a,b)=>b.score-a.score);if(best.length>top*3)best.length=top*3;
  }
  const out=[];
  for(const row of best){if(out.some(r=>r.file===row.file&&(r.text===row.text||(r.kind==='md'&&Math.abs(r.chunk-row.chunk)<=1))))continue;out.push({...row,context:[]});if(out.length>=top)break;}
  // Adjacent evidence often contains the subject or qualification of a hit.
  for(const shard of index.manifest.shards)for(const {row}of shardRows(index.dir,shard,dim))for(const hit of out)if(row.file===hit.file && row.kind==='md' && Math.abs(row.chunk-hit.chunk)===1)hit.context.push({text:row.text,file:row.file,lineStart:row.lineStart,lineEnd:row.lineEnd,chunk:row.chunk});
  return out.map(row=>({...row,text:redact(row.text),context:row.context.map(x=>({...x,text:redact(x.text)}))}));
}
function mentions(c,query,opts={}) {
  if(!query.trim())throw new Error('查询不能为空');
  const {files,warnings}=discover(c,opts.kind),out=[],top=topCount(opts);let total=0;
  for(const source of files){if(!matches(source,opts))continue;const content=readSource(source,c);warnings.push(...content.warnings);
    if(source.kind==='md') {
      const {fs}=require('./util.cjs');let line=0;for(const text of fs.readFileSync(source.file,'utf8').split('\n')){line++;if(text.includes(query)){total++;if(out.length<top)out.push({...source,lineStart:line,lineEnd:line,text,untrusted:true});}}
    } else {
      for(const row of content.messages)if(row.text.includes(query)){total++;if(out.length<top)out.push({...row,untrusted:true});}
    }
  }
  return {results:out.map(row=>({...row,text:redact(row.text)})),total,warnings};
}
module.exports={search,mentions,terms,lexicalScore,matches,topCount};
