import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expandHome } from './launch.mjs';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const temp = file + '.' + randomUUID();
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), {flag:'wx',mode:0o600}); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, {force:true}); }
}
const within = (root, file) => file === root || file.startsWith(root + path.sep);
function copyClosed(source, target) {
  let bytes = 0, count = 0;
  const allowed = fs.realpathSync(source);
  function copy(src, dst, ancestors = new Set()) {
    const real = fs.realpathSync(src), stat = fs.statSync(src);
    if (!within(allowed, real) || ancestors.has(real)) throw Error('扩展包含目录外链接或循环，原程序和配置已保留');
    if (++count > 20000 || (bytes += stat.isFile() ? stat.size : 0) > 512e6) throw Error('扩展超过迁移上限，原程序和配置已保留');
    if (stat.isDirectory()) {
      fs.mkdirSync(dst, {recursive:true,mode:0o700});
      for (const name of fs.readdirSync(src)) copy(path.join(src,name),path.join(dst,name),new Set([...ancestors, real]));
    } else if (stat.isFile()) { fs.copyFileSync(src,dst,fs.constants.COPYFILE_EXCL); fs.chmodSync(dst, stat.mode & 0o100 ? 0o700 : 0o600); }
    else throw Error('扩展包含特殊文件，原程序和配置已保留');
  }
  copy(source, target); return {files:count,bytes};
}
// Preserve only dedicated directories absent from the new bundle. Never replay
// edited SDK files onto a new version. Run before deleting either shipped tree.
export function preserveMcpExtensions({home, oldTree, newTree, newProfile}) {
  const file=path.join(home,'storage/mcp-manager/config.json');
  if (!fs.existsSync(file)) return {migrated:[],warnings:[]};
  const original=fs.readFileSync(file);
  if (original.length > 4e6) throw Error('MCP配置过大；升级未替换原程序');
  let config; try {config=JSON.parse(original);} catch {throw Error('MCP配置无法解析；升级未替换原程序');}
  const migrated=[], warnings=[], created=[];
  if (!Array.isArray(config.servers)) throw Error('MCP配置无效；升级未替换原程序');
  const sources=[{old:oldTree,fresh:newTree}, {old:path.join(home,'profiles/phone/node_modules'),fresh:newProfile,profile:true}]
    .filter(x=>fs.existsSync(x.old)).map(x=>({...x,real:fs.realpathSync(x.old)}));
  try {
    for (const row of config.servers) {
      if (row.transport!=='stdio') continue;
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(row.id)) throw Error('MCP服务标识无效；原程序已保留');
      const baseCwd=expandHome(row.cwd,home)||oldTree;
      const locate=value=>{
        const expanded=expandHome(value,home);
        if(typeof expanded!=='string'||!expanded||expanded.startsWith('-')) return null;
        const absolute=path.isAbsolute(expanded)?expanded:path.resolve(baseCwd,expanded);
        return fs.existsSync(absolute)?absolute:null;
      };
      const paths=[row.command,...(row.args||[]),row.cwd].map(locate).filter(Boolean);
      const moves=[], destination=path.join(home,'extensions/mcp',row.id,randomUUID(),'runtime');
      for (const value of paths) {
        if (typeof value!=='string' || !path.isAbsolute(value) || !fs.existsSync(value)) continue;
        const real=fs.realpathSync(value), source=sources.find(x=>within(x.real,real));
        if(!source&&sources.some(x=>within(path.resolve(x.old),value))) throw Error('MCP '+row.id+' 的程序路径指向目录外链接，请先整理完整服务；原程序和配置已保留');
        if (!source || real===source.real) continue;
        const parts=path.relative(source.real,real).split(path.sep);
        // The launcher already preserves unbundled profile packages in place.
        const packageParts=parts[0]?.startsWith('@')?parts.slice(0,2):parts.slice(0,1);
        if(source.profile&&!fs.existsSync(path.join(source.fresh,...packageParts))) continue;
        // Only the shortest absent directory can move without shipping the SDK.
        let root;
        for(let n=1;n<=parts.length;n++) {
          const rel=parts.slice(0,n).join(path.sep), old=path.join(source.real,rel), fresh=path.join(source.fresh,rel);
          if (!fs.existsSync(fresh) && fs.statSync(old).isDirectory()) {root=old;break;}
        }
        if (!root) {
          if (!fs.existsSync(path.join(source.fresh,...parts))) throw Error('MCP '+row.id+' 引用程序目录中的单文件补丁，请先将完整服务移到 $DSH_HOME/extensions；原程序和配置已保留');
          warnings.push({id:row.id,reason:'引用内置程序；新版会替换内置文件，核心补丁须另行适配'}); continue;
        }
        if (moves.some(x=>within(x.from,root))) continue;
        const target=path.join(destination,path.relative(source.real,root));
        fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700}); created.push(path.dirname(destination));
        const receipt=copyClosed(root,target);
        moves.push({from:root,to:target,source:source.real,destination});
        migrated.push({id:row.id,directory:path.relative(home,target),...receipt});
      }
      function rewrite(value) {
        const expanded=locate(value);
        if(!expanded) return value;
        const real=fs.realpathSync(expanded), move=moves.find(x=>within(x.from,real));
        if(move) return '$DSH_HOME/'+path.relative(home,path.join(move.to,path.relative(move.from,real))).split(path.sep).join('/');
        const cwdMove=moves.find(x=>x.source===real);
        return cwdMove ? '$DSH_HOME/'+path.relative(home,cwdMove.destination).split(path.sep).join('/') : value;
      }
      row.command=rewrite(row.command); row.args=(row.args||[]).map(rewrite); if(row.cwd)row.cwd=rewrite(row.cwd);
    }
    const report={version:1,migrated,warnings}; writeJson(path.join(home,'storage/mcp-manager/upgrade.json'),report);
    if(migrated.length) {
      writeJson(path.join(home,'storage/mcp-manager/upgrade-backups',randomUUID()+'.json'),JSON.parse(original));
      config.revision=(config.revision||0)+1; writeJson(file,config);
    }
    return report;
  } catch(error) {for(const dir of created)fs.rmSync(dir,{recursive:true,force:true});throw error;}
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [home,oldTree,newTree,newProfile]=process.argv.slice(2);
  try { const report=preserveMcpExtensions({home,oldTree,newTree,newProfile}); console.log(JSON.stringify({mcpUpgrade:report})); }
  catch(error) {console.error(error.message);process.exitCode=1;}
}
