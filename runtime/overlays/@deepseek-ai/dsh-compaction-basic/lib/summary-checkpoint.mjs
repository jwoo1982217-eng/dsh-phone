import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const clean = value => String(value ?? '').replace(/\bsk-[\w-]{12,}|Bearer\s+[^\s]+/gi, '[credential]')
  .replace(/((?:api[_-]?key|token|secret|password|cookie)\s*[=:]\s*)[^\s,;]+/gi, '$1[credential]');
const text = m => (m?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

// Separate from the Session transaction: failed batches never replace history.
// Only source-identical completed summaries can be reused by a later attempt.
export class SummaryCheckpoint {
  constructor(agent, input, route, log) {
    this.log = log;
    this.state = {version: 1, sessionId: agent.session.id, cwd: agent.session.header?.cwd,
      phase: 'preparing', cache: {}, calls: 0, reused: 0};
    if (process.env.DSH_HOME && this.state.cwd) {
      this.file = path.join(process.env.DSH_HOME, 'storage/context-recovery', digest(agent.session.id) + '.json');
      try {
        if (fs.lstatSync(this.file).isSymbolicLink()) throw Error('checkpoint must not be a symlink');
        const stat = fs.statSync(this.file);
        if (stat.size > 2e6) throw Error('checkpoint is too large');
        const old = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (old.version !== 1 || old.sessionId !== this.state.sessionId || old.cwd !== this.state.cwd
          || !old.cache || typeof old.cache !== 'object' || Array.isArray(old.cache)) throw Error('checkpoint identity or format does not match');
        this.state.cache = old.cache;
      } catch (error) {
        if (error.code !== 'ENOENT') { this.log?.warn('compaction checkpoint preserved: %s', error.message); this.file = undefined; }
      }
    }
    const users = input.messages.filter(m => m.role === 'user' && m.source?.kind !== 'runtime-context');
    this.state.sourceRevision = agent.session.seq;
    this.state.sourceDigest = digest(input);
    this.state.route = route;
    this.state.task = {originalRequest: clean(text(users[0])).slice(0, 2400),
      latestRequest: clean(text(users.at(-1))).slice(-2400),
      resumeRule: 'Keep user corrections, exact paths, observed edits and verification results. Check on-disk state and unfinished jobs before resuming; never replay an uncertain tool action automatically.'};
    this.update({phase: 'preparing'});
  }
  get(key) {
    const row = this.state.cache[key];
    if (!row || typeof row.text !== 'string' || row.sha256 !== digest(row.text)) return;
    this.update({reused: this.state.reused + 1});
    return row.text;
  }
  put(key, value) {
    // Do not persist credentials in an auxiliary cache.
    if (clean(value) === value) this.state.cache[key] = {text: value, sha256: digest(value)};
    const entries = Object.entries(this.state.cache).slice(-96);
    this.state.cache = Object.fromEntries(entries);
    this.update({});
  }
  update(values) {
    Object.assign(this.state, values, {updatedAt: new Date().toISOString()});
    if (!this.file) return;
    const bytes = JSON.stringify(this.state);
    if (Buffer.byteLength(bytes) > 2e6) { this.state.cache = {}; return this.update({}); }
    const temporary = this.file + '.' + randomUUID();
    try {
      fs.mkdirSync(path.dirname(this.file), {recursive: true, mode: 0o700});
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch (error) { this.log?.warn('compaction checkpoint save failed: %s', error.message); }
    finally { try { fs.rmSync(temporary, {force: true}); } catch {} }
  }
}
