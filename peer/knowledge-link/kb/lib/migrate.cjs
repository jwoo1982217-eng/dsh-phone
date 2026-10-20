'use strict';
const {fs,path,hash,lock}=require('./util.cjs');
const {current,writeCache,commit}=require('./store.cjs');
function migrate(c,opts={}) {
  if(!opts.legacy&&!opts['legacy-sessions'])throw new Error('请用 --legacy 指定旧 .kb-index.jsonl，或 --legacy-sessions 指定旧会话索引');
  const release=lock(c.dataDir);
  try {
    const caches=[],warnings=['旧索引未记录模型身份；仅当其确实使用当前同一模型时才能信任语义分数。原索引完整保留。'];
    const old=current(c);if(old && !opts.force)throw new Error('已有新版索引；使用 --force 才会导入替换，原一代仍可 rollback');
    let dim;
    for(const [file,kind]of [[opts.legacy,'md'],[opts['legacy-sessions'],'session']]) {
      if(!file)continue;
      const absolute=path.resolve(file),raw=fs.readFileSync(absolute),lines=raw.toString('utf8').split('\n').filter(x=>x.trim());
      const input=lines.map(JSON.parse),groups=new Map();let binary;
      if(kind==='session'&&input.some(r=>!Array.isArray(r.v))) {
        const binFile=[absolute+'.bin',path.join(path.dirname(absolute),'.ses-index.bin')].find(f=>fs.existsSync(f));
        if(!binFile)throw new Error('旧会话索引缺少向量 bin');binary=fs.readFileSync(binFile);
        if(binary.length!==input.length*512*4)throw new Error('旧会话 bin 长度与文本行数不一致');
      }
      input.forEach((r,i)=>{
        let vector=r.v;
        if(!vector&&binary)vector=Array.from({length:512},(_,j)=>binary.readFloatLE((i*512+j)*4));
        if(!Array.isArray(vector)||!vector.length)throw new Error('旧索引行缺少向量');
        if(dim&&dim!==vector.length)throw new Error('旧索引含多种向量维度');dim=vector.length;
        const f=r.file||r.key;if(typeof f!=='string'||typeof r.text!=='string')throw new Error('旧索引缺少出处或正文');
        const actual=path.isAbsolute(f)?f:path.resolve(process.env.KB_WORKSPACE||c.sources[0].path,f),id=kind+':'+actual;
        if(!groups.has(id))groups.set(id,{source:{id,file:actual,relative:f,kind,source:'legacy',cat:kind==='session'?'session':(f.includes('/')?f.split('/')[0]:'root'),sub:''},rows:[],vectors:[]});
        const g=groups.get(id),{v,...rest}=r;g.rows.push({...rest,...g.source});g.vectors.push(vector);
      });
      for(const [id,g]of groups){const fingerprint=hash(raw),key=hash('legacy\0'+id+'\0'+fingerprint+'\0'+c.signature);const {cached}=require('./store.cjs');caches.push(cached(c,key)||writeCache(c,key,g.source,{rows:g.rows,fingerprint,mtime:0,size:raw.length,warnings:[]},g.vectors,dim));}
    }
    if(!caches.length)throw new Error('旧索引为空，没有修改当前索引');
    return commit(c,caches,dim,warnings);
  }finally{release();}
}
module.exports={migrate};
