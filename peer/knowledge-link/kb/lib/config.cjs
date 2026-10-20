'use strict';
const os = require('node:os');
const { fs, path, json, hash } = require('./util.cjs');
const HOME = os.homedir();
function config(opts = {}) {
  const file = path.resolve(opts.config || process.env.KB_CONFIG || path.join(__dirname, '..', 'config.local.json'));
  const supplied = fs.existsSync(file) ? json(file) : {};
  const base = path.dirname(file);
  const absolute = p => path.resolve(base, p);
  const ws = opts.workspace || process.env.KB_WORKSPACE;
  const sr = opts['sessions-root'] || process.env.KB_SESSIONS_ROOT;
  const c = {
    dataDir: absolute(opts['data-dir'] || process.env.KB_DATA_DIR || supplied.dataDir || path.join(HOME, '.local/share/kb-lite')),
    sources: ws ? [{ name: 'workspace', path: path.resolve(ws) }] : (supplied.sources || [{ name: 'memory', path: path.join(HOME, 'agent-memory') }]).map(x=>({...x,path:absolute(x.path)})),
    sessionsRoots: sr ? [path.resolve(sr)] : (supplied.sessionsRoots || [path.join(HOME,'.dsh')]).map(absolute),
    shardSize: Number(opts['shard-size'] || supplied.shardSize || 2000),
    chunkSize: supplied.chunkSize || 420, overlap: supplied.overlap ?? 70,
    maxFileBytes: supplied.maxFileBytes ?? 64*1024*1024,
    model: supplied.model || 'Xenova/bge-small-zh-v1.5',
    revision: supplied.revision || 'main',
    dtype: 'q8',
    pooling: supplied.pooling || 'cls',
    cacheDir: absolute(supplied.cacheDir || path.join(HOME,'.cache/kb-lite/models')),
    embedUrl: process.env.KB_EMBED_URL || supplied.embedUrl || null,
    queryPrefix: '为这个句子生成表示以用于检索相关文章：',
    offline: opts.offline || !opts.download,
    configFile: file
  };
  if (!Number.isInteger(c.shardSize) || c.shardSize<1 || c.shardSize>20000) throw new Error('shardSize 必须为 1..20000');
  if (c.chunkSize<100 || c.overlap<0 || c.overlap>=c.chunkSize) throw new Error('分块长度或重叠不合法');
  if (new Set(c.sources.map(s=>s.name)).size!==c.sources.length || c.sources.some(s=>!s.name)) throw new Error('资料源名称必须非空且唯一');
  if(!['cls','mean'].includes(c.pooling))throw new Error('pooling 只能为 cls 或 mean');
  c.signature = hash(JSON.stringify({model:c.model,revision:c.revision,dtype:c.dtype,pooling:c.pooling,queryPrefix:c.queryPrefix,chunk:c.chunkSize,overlap:c.overlap,parser:2,endpoint:c.embedUrl}));
  return c;
}
module.exports = { config };
