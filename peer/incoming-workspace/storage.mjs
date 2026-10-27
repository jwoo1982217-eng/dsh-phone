import fs from 'node:fs';
import {mkdir,lstat,realpath,open,readFile,rename,readdir,unlink,link} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';

export const MAX_FILES=16,MAX_FILE_BYTES=256*1024*1024;
export const validId=id=>typeof id==='string'&&/^[a-f0-9]{32}$/.test(id);
export const leaf=name=>typeof name==='string'&&name!=='.'&&name!=='..'&&name.length>0&&Buffer.byteLength(name)<=250&&!/[\\/\x00-\x1f\x7f]/.test(name);
export class IncomingStorage {
 constructor(home){this.home=path.resolve(home);this.ready=null;}
 async init(){if(!this.ready)this.ready=this.initialize().catch(e=>{this.ready=null;throw e;});return this.ready;}
 async initialize(){
  const home=await realpath(this.home);await this.directory(home);const storage=await this.child(home,'storage');this.root=await this.child(storage,'incoming-workspaces');
  const marker=path.join(this.root,'.owner.json');
  try{await lstat(marker);}catch(e){
   if(e.code!=='ENOENT')throw e;
   if((await readdir(this.root)).length)throw Error('已有同名目录但缺少来件归属记录，未接管或清理');
   let output;try{output=await open(marker,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);await output.writeFile(JSON.stringify({type:'dsh.incoming-root/v1',owner:randomBytes(16).toString('hex')})+'\n');await output.sync();}catch(error){if(error.code!=='EEXIST')throw error;}finally{await output?.close();}
  }
  const stat=await lstat(marker);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024)throw Error('来件归属记录无效');const input=await open(marker,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let value;try{value=JSON.parse(await input.readFile('utf8'));}finally{await input.close();}
  if(value.type!=='dsh.incoming-root/v1'||!validId(value.owner))throw Error('来件归属记录无效');this.owner=value.owner;return this.root;
 }
 async directory(value){const s=await lstat(value);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(value)!==value)throw Error('来件工作区目录或符号链接无效');return value;}
 async child(parent,name){await this.directory(parent);const target=path.join(parent,name);try{await mkdir(target,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}return this.directory(target);}
 async batch(id,create=false){if(!validId(id))throw Error('来件批次 ID 无效');const root=await this.init();await this.directory(root);const dir=path.join(root,id);if(create)return this.child(root,id);await this.directory(dir);return dir;}
 async content(id,create=false){const dir=await this.batch(id);return create?this.child(dir,'files'):this.directory(path.join(dir,'files'));}
 async manifest(id){const dir=await this.batch(id),file=path.join(dir,'manifest.json'),s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>262144)throw Error('来件清单无效');const fh=await open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{return JSON.parse(await fh.readFile('utf8'));}finally{await fh.close();}}
 async save(id,value){const dir=await this.batch(id),temp=path.join(dir,'.manifest-'+randomBytes(12).toString('hex'));let fh;try{fh=await open(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);await fh.writeFile(JSON.stringify(value)+'\n');await fh.sync();await fh.close();fh=null;await this.directory(dir);const target=path.join(dir,'manifest.json');try{if((await lstat(target)).isSymbolicLink())throw Error('来件清单链接无效');}catch(e){if(e.code!=='ENOENT')throw e;}await rename(temp,target);}finally{await fh?.close();await unlink(temp).catch(()=>{});}}
 async copy(id,index,source,signal){const dir=await this.content(id),destination=path.join(dir,source.name),temporary=path.join(dir,'.part-'+index);await this.directory(dir);let handle;
  try{handle=await open(destination,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);await this.verifyHandle(handle,source);return;}catch(e){if(e.code!=='ENOENT')throw e;}finally{await handle?.close();}
  let size=0;const hash=createHash('sha256');const meter=new Transform({transform(chunk,_enc,done){size+=chunk.length;if(size>MAX_FILE_BYTES){done(Error('来件超过 256 MB'));return;}hash.update(chunk);done(null,chunk);}});
  try{try{await unlink(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}await pipeline(source.handle.createReadStream({autoClose:false}),meter,fs.createWriteStream(temporary,{flags:'wx',mode:0o600}),{signal});if(size!==source.size||hash.digest('hex')!==source.sha256)throw Error('来件源文件已变化或校验失败');await this.directory(dir);await link(temporary,destination);await unlink(temporary);await this.directory(dir);await this.verify(id,source);}catch(e){await this.directory(dir);await unlink(temporary).catch(()=>{});throw e;}
 }
 async verifyHandle(handle,file){const s=await handle.stat();if(!s.isFile()||s.size!==file.size)throw Error('来件文件已变化或校验失败');const hash=createHash('sha256');for await(const bytes of handle.createReadStream({autoClose:false}))hash.update(bytes);if(hash.digest('hex')!==file.sha256)throw Error('来件文件已变化或校验失败');}
 async verify(id,file){const dir=await this.content(id),target=path.join(dir,file.name);if(!leaf(file.name)||(await lstat(target)).isSymbolicLink())throw Error('来件文件链接无效');const handle=await open(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{await this.verifyHandle(handle,file);}finally{await handle.close();}}
 async entries(){const root=await this.init();await this.directory(root);return readdir(root);}
 async removable(id,manifest){const dir=await this.batch(id),content=await this.content(id);if((await readdir(dir)).some(x=>x!=='files'&&x!=='manifest.json'))return false;const permitted=new Set(manifest.files.map(f=>f.name));for(let n=0;n<manifest.sourcePaths.length;n++)permitted.add('.part-'+n);for(const name of await readdir(content)){if(!permitted.has(name))return false;const s=await lstat(path.join(content,name));if(!s.isFile()||s.isSymbolicLink())return false;const expected=manifest.files.find(f=>f.name===name);if(expected)await this.verify(id,expected);}return true;}
 async removeFiles(id,manifest){const dir=await this.batch(id),content=await this.content(id),names=new Set(manifest.files.map(f=>f.name));for(let n=0;n<manifest.sourcePaths.length;n++)names.add('.part-'+n);for(const name of names){await this.directory(content);try{const file=path.join(content,name),s=await lstat(file);if(!s.isFile()||s.isSymbolicLink())throw Error('来件清理目录已变化');await unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}}return dir;}
}
