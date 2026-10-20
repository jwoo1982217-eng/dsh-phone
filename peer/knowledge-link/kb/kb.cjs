#!/usr/bin/env node
'use strict';
process.umask(0o077);
const {fs,path,json,writeJson,parseArgs}=require('./lib/util.cjs');
const {config}=require('./lib/config.cjs');
const {current,build,rollback}=require('./lib/store.cjs');
const {search,mentions}=require('./lib/search.cjs');
const HELP=`KB Lite 3.1 · 本地资料与 DSH 历史会话检索
node kb.cjs setup --download     首次下载本地语义模型
node kb.cjs index                增量建库（资料＋会话）
node kb.cjs sesindex             只更新会话，保留资料索引
node kb.cjs search "查询"         语义＋关键词搜索
node kb.cjs search "查询" --lexical  只查关键词，无需模型
node kb.cjs presearch "查询"      JSON 结果，供助手调用
node kb.cjs mentions "字符串"     原始资料精确匹配，无需索引/模型
node kb.cjs stats | cats | tags | doctor
node kb.cjs migrate --legacy /旧索引路径
node kb.cjs rollback             回到上一代已验证完整索引
选项：--cat 类别 --sub 子类 --kind md|session --top 6 --json
配置：--config 文件；KB_WORKSPACE / KB_SESSIONS_ROOT / KB_DATA_DIR
离线为默认。首次 setup --download 只下载模型，不发送记忆正文。`;
async function main(args=process.argv.slice(2)) {
  const [command,...rest]=args;
  if(!command||command==='help'||command==='--help'){console.log(HELP);return;}
  const {opts,words}=parseArgs(rest),c=config(opts),query=words.join(' ');
  if(opts.kind&&!['md','session'].includes(opts.kind))throw new Error('--kind 只能为 md 或 session');
  let worker;
  const embed=async(texts,kind)=>{
    if(!worker){const {createEmbedder}=await import('./lib/embedding.mjs');worker=await createEmbedder(c);}
    return worker.embed(texts,kind);
  };
  const output=value=>console.log(JSON.stringify(value,null,opts.json?2:undefined));
  const present=rows=>{
    if(opts.json||command==='presearch'){output(rows);return;}
    if(!rows.length){console.log('未找到匹配内容。');return;}
    rows.forEach((r,i)=>{
      const time=r.time?new Date(r.time).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'';
      console.log(`\n${i+1}. ${r.relative||r.file}${time?' · '+time:''}${r.score!==undefined?' · '+r.score.toFixed(3):''}`);
      console.log(r.text);console.log(`出处：${r.file}${r.lineStart?':'+r.lineStart:''}${r.seqStart!==undefined?' · seq '+r.seqStart+'..'+r.seqEnd:''}`);
      for(const context of r.context||[])console.log(`〔相邻内容 ${context.file}:${context.lineStart}〕\n${context.text}`);
    });
  };
  try {
    if(command==='setup') {
      if(opts.download && !c.embedUrl){const {downloadModel}=await import('./lib/download.mjs');await downloadModel(c);c.offline=true;}
      const vector=(await embed(['本地语义模型准备检查'],'query'))[0];output({ready:true,model:c.model,revision:c.revision,dim:vector.length,offline:c.offline,cacheDir:c.cacheDir});
    }else if(['index','sesindex'].includes(command)){
      const result=await build(c,command==='sesindex'?'session':opts.kind,embed,{force:opts.force,log:line=>process.stderr.write('[kb] '+line+'\n')});
      output({generation:result.id,changed:result.changed,reused:result.reused,embedded:result.embedded,reusedChunks:result.reusedChunks,noOp:!!result.noOp,files:result.manifest.sources.length,chunks:result.manifest.count,shards:result.manifest.shards.length,warnings:result.manifest.warnings});
    }else if(['search','presearch','sessearch'].includes(command)){
      if(command==='sessearch')opts.kind='session';
      if(opts.refresh)await build(c,undefined,embed,{log:line=>process.stderr.write('[refresh] '+line+'\n')});
      present(await search(c,query,opts,embed));
    }else if(['mentions','sesmentions'].includes(command)){
      if(command==='sesmentions')opts.kind='session';const found=mentions(c,query,opts);present(found.results);if(!opts.json)console.log(`\n共 ${found.total} 处匹配。`);for(const warning of found.warnings)process.stderr.write(warning+'\n');
    }else if(['stats','sesstats','cats'].includes(command)){
      const index=current(c);if(!index){output({indexed:false});return;}
      const mf=index.manifest;
      if(command==='cats'){
        const {shardRows}=require('./lib/store.cjs'),categories={};for(const shard of mf.shards)for(const {row}of shardRows(index.dir,shard,mf.dim)){const key=row.cat+(row.sub?'/'+row.sub:'');categories[key]=(categories[key]||0)+1;}output(categories);
      }else{const sources=command==='sesstats'?mf.sources.filter(s=>s.kind==='session'):mf.sources;output({generation:index.id,createdAt:mf.createdAt,files:sources.length,chunks:sources.reduce((s,x)=>s+x.count,0),shards:mf.shards.length,dim:mf.dim,bytes:mf.shards.reduce((s,x)=>s+x.bytes,0),categories:mf.cats,sources:sources.map(s=>({file:s.file,kind:s.kind,chunks:s.count,bytes:s.size})),warnings:mf.warnings});}
    }else if(command==='doctor'){
      const {discover}=require('./lib/sources.cjs'),found=discover(c);output({node:process.version,zstd:typeof require('node:zlib').zstdDecompressSync==='function',config:c.configFile,dataDir:c.dataDir,model:c.model,offline:c.offline,sourceFiles:found.files.filter(s=>s.kind==='md').length,sessionFiles:found.files.filter(s=>s.kind==='session').length,indexed:!!current(c),warnings:found.warnings});
    }else if(command==='migrate'){
      const result=require('./lib/migrate.cjs').migrate(c,opts);output({generation:result.id,chunks:result.manifest.count,warnings:result.manifest.warnings});
    }else if(command==='rollback'){output({generation:rollback(c)});
    }else if(command==='tags'){
      const {discover}=require('./lib/sources.cjs'),tags={};for(const source of discover(c,'md').files){const text=fs.readFileSync(source.file,'utf8'),front=text.match(/^---\r?\n([\s\S]*?)\r?\n---/);for(const entry of front?.[1].matchAll(/tags:\s*\[([^\]]*)\]/g)||[])for(const t of entry[1].split(',').map(x=>x.trim()).filter(Boolean))(tags[t]||=[]).push(source.file);}const file=path.join(c.dataDir,'tags.json');writeJson(file,tags);output({file,tags});
    }else throw new Error('未知命令：'+command+'；运行 help 查看用法');
  }finally{if(worker)await worker.dispose();}
}
if(require.main===module)main().catch(error=>{console.error('[kb] '+error.message);process.exitCode=1;});
module.exports={main};
