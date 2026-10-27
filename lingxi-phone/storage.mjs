import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const KINDS=['knowledge','project','record','archive','writing','diary'];
export const digest=s=>createHash('sha256').update(s).digest('hex');
export function check(ok,message){if(!ok)throw Error(message)}
export function text(value,label,max=2000){check(typeof value==='string'&&value.trim().length>0&&value.length<=max,label+'无效');return value.trim()}
export function integer(n,fallback,min,max){n=n??fallback;check(Number.isInteger(n)&&n>=min&&n<=max,'分页参数无效');return n}
export function notePath(n){return n.kind+'/'+n.id+'.md'}
export function publicNote(n){return {id:n.id,path:notePath(n),title:n.title,type:n.kind,tags:n.tags,project:n.project,status:n.status,revision:n.revision,updatedAt:n.updatedAt}}
export function snapshot(home){
  let fd;try{fd=fs.openSync(path.join(home,'knowledge/workbench/state.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)}catch(e){if(e.code==='ENOENT')return {version:1,notes:[]};throw e}
  try{check(fs.fstatSync(fd).size<=64*1024*1024,'知识库目录超过手机适配版的 64 MiB 单次读取上限');const s=JSON.parse(fs.readFileSync(fd,'utf8'));check(s.version===1&&Array.isArray(s.notes),'知识库格式不受支持，原文件保持');return s}finally{fs.closeSync(fd)}
}
export function active(home){return snapshot(home).notes.filter(n=>!n.deletedAt)}
export function resolveNote(home,p){
  check(typeof p==='string','笔记路径无效');const m=p.match(/^(?:(knowledge|project|record|archive|writing|diary)\/)?(n-[a-f0-9-]{36})(?:\.md)?$/);
  check(m,'请使用 kb_list/kb_search 返回的笔记路径');const n=active(home).find(n=>n.id===m[2]&&(!m[1]||n.kind===m[1]));check(n,'笔记不存在或已在回收站');return n;
}
export function directory(value=''){check(typeof value==='string'&&(!value||KINDS.includes(value.replace(/\/$/,''))),'目录应为分类名，例如 knowledge');return value.replace(/\/$/,'')}
export function boundary(summary,taskType='general'){
  const t=text(summary,'摘要',10000), low=t.toLowerCase();
  const memory=t.length>=30&&['偏好','习惯','以后','长期','默认','喜欢','不喜欢','记住','用户要求','每次','优先'].some(k=>t.includes(k));
  const kb=t.length>=30&&(t.length>=120||['实现','修改','文件','接口','api','mcp','配置','验证','部署','脚本','bug','项目','日志'].some(k=>low.includes(k))||['project','development','research'].includes(taskType));
  return {write_to_kb:kb,suggest_memory_update:memory,memory_candidate:memory?t.replace(/\n/g,' ').slice(0,280):'',automatic_memory_write:false,rule:'偏好/稳定事实只生成待核实候选；项目过程进入笔记。不会自动写长期记忆。'};
}
export function storeAsset(home,{content,content_base64,file_path,filename,target_dir='_assets'}){
  let raw;
  if(content_base64){check(typeof content_base64==='string'&&content_base64.length<=7*1024*1024&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content_base64),'Base64 内容无效');raw=Buffer.from(content_base64,'base64')}
  else if(content!==undefined&&content!==''){check(typeof content==='string','上传内容应为文本');raw=Buffer.from(content)}
  else if(file_path){check(path.isAbsolute(file_path),'本机文件路径须为绝对路径');const fd=fs.openSync(file_path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{check(fs.fstatSync(fd).isFile()&&fs.fstatSync(fd).size<=5*1024*1024,'文件无效或超过 5 MiB');raw=fs.readFileSync(fd)}finally{fs.closeSync(fd)};filename=filename||path.basename(file_path)}
  check(raw&&raw.length<=5*1024*1024,'请提供文件内容；单文件上限 5 MiB');
  const name=filename||'note.md';check(typeof name==='string'&&name===path.basename(name)&&!/[\x00-\x1f\\]/.test(name)&&name.length<=180&&name!=='.'&&name!=='..','文件名无效');
  check(typeof target_dir==='string'&&/^[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)*$/u.test(target_dir)&&!target_dir.split('/').some(x=>x==='.'||x==='..'),'附件目录无效');
  const hash=digest(raw),root=path.join(home,'storage/lingxi-phone'),parts=['storage','lingxi-phone',...target_dir.split('/')];let dir=home;
  for(const p of parts){dir=path.join(dir,p);try{fs.mkdirSync(dir,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e}check(fs.lstatSync(dir).isDirectory()&&!fs.lstatSync(dir).isSymbolicLink(),'附件目录不能是链接')}
  const file=path.join(dir,hash+'-'+name);try{fs.writeFileSync(file,raw,{mode:0o600,flag:'wx'})}catch(e){if(e.code!=='EEXIST')throw e;check(!fs.lstatSync(file).isSymbolicLink()&&digest(fs.readFileSync(file))===hash,'同名附件冲突，原文件已保留')}
  return {path:file,relativePath:path.relative(root,file),sha256:hash,bytes:raw.length,indexed:false};
}
