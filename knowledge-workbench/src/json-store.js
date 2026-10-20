import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
export const resolveDshHome=()=>process.env.DSH_HOME?.trim()||path.join(os.homedir(),'.dsh')
export const emptyState=()=>({version:2,revision:0,preferences:{showProvider:false},groups:[]})
export class JsonStore{
 constructor(file,initial,options={}){this.file=file;this.options=options;try{this.value=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw Error('配置无法读取，原文件已保留：'+file);this.value=structuredClone(initial)}}
 get(){return this.value}
 set(next){const dir=path.dirname(this.file),temp=this.file+'.tmp-'+process.pid;fs.mkdirSync(dir,{recursive:true});try{fs.writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600});fs.renameSync(temp,this.file);this.value=next;return next}finally{try{fs.unlinkSync(temp)}catch{}}}
 update(fn){const next=structuredClone(this.value);fn(next);return this.set(next)}
 flush(){return this.set(this.value)}
}
