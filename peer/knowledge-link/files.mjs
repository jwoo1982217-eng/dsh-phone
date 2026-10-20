import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export const hash=b=>createHash('sha256').update(b).digest('hex');
export const check=(v,m)=>{if(!v)throw Error(m);};
export const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
export function noLinks(file){let p=path.resolve(file);while(p!==path.dirname(p)){if(fs.existsSync(p))check(!fs.lstatSync(p).isSymbolicLink(),'路径包含符号链接');p=path.dirname(p);if(p==='/var'||p==='/data')break;}}
export function save(file,value){noLinks(file);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID();try{const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}}
export function regular(file,max=32*1024*1024){noLinks(file);const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);check(st.isFile()&&st.size<=max,'资源超出大小限制或不是普通文件');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}}
export function walk(root,predicate=()=>true,max=50000){if(!fs.existsSync(root))return [];noLinks(root);const out=[];function visit(dir,depth){check(depth<24,'资源目录过深');for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.isSymbolicLink())throw Error('资源包含符号链接，不能发送');if(e.name.startsWith('.')||['node_modules','__pycache__'].includes(e.name))continue;const f=path.join(dir,e.name);if(e.isDirectory())visit(f,depth+1);else if(e.isFile()&&predicate(f)){out.push(f);check(out.length<=max,'资源文件过多，请缩小选择');}}}visit(root,0);return out;}
export const safeName=n=>typeof n==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(n)&&n!=='.'&&n!=='..';
export function safeRelative(n){check(typeof n==='string'&&n.length<1000&&!/[\\\x00-\x1f:]/.test(n)&&!n.startsWith('/')&&n.split('/').every(s=>s&&s!=='.'&&s!=='..'),'资源路径无效');return n;}
export function secretFree(bytes,name=''){check(!/(?:^|\/)(?:id_rsa|id_ed25519|credentials?[^/]*|settings\.ya?ml|api-key|[^/]*\.(?:pem|p12|key))$/i.test(name),'选择中包含凭据文件');if(bytes.includes(0))return;const s=bytes.toString('utf8');check(!/(?:\b(?:sk-|hf_|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{24,}|\bBearer\s+[A-Za-z0-9._-]{32,})/.test(s),'选择中包含疑似真实凭据，请移除后重试');}
