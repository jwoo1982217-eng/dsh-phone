/** Affection system: durable score state + master-only floating window.
 *
 * The model books every change through the qq_set_affection tool; the state
 * lives in <dshHome>/affection.json and is served as a live dashboard on
 * 127.0.0.1:<port> (loopback-only, token-gated) for 主人's floating window.
 */
import { promises as fs, readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
/** Stages are HERS: she defines the ladder from her own memory via qq_set_stage.
 * The system only records what she declares — ascents, descents, renames, all real. */
export class AffectionStore {
    log;
    state = { score: 0, stage: '初识', events: [], stageHistory: [] };
    file;
    token = randomUUID().replace(/-/g, '');
    workspacePath = null;
    onSubmit = null;
    constructor(dshHome, log) {
        this.log = log;
        this.file = path.join(dshHome, 'affection.json');
    }
    /** Persona display names for the dashboard. */
    persona = { selfName: 'Assistant', masterName: 'Boss' };
    /** Wire the master-only task injection and the workspace the diaries live in. */
    configure(opts) {
        if (opts.workspacePath !== undefined)
            this.workspacePath = opts.workspacePath;
        if (opts.onSubmit !== undefined)
            this.onSubmit = opts.onSubmit;
        if (opts.selfName !== undefined)
            this.persona.selfName = opts.selfName;
        if (opts.masterName !== undefined)
            this.persona.masterName = opts.masterName;
    }
    async load() {
        try {
            const raw = JSON.parse(await fs.readFile(this.file, 'utf-8'));
            if (typeof raw.score === 'number') {
                this.state = {
                    score: raw.score,
                    stage: typeof raw.stage === 'string' ? raw.stage : '道侣未遂',
                    events: Array.isArray(raw.events) ? raw.events.slice(-100) : [],
                    stageHistory: Array.isArray(raw.stageHistory) ? raw.stageHistory : [],
                };
            }
        }
        catch {
            await this.save();
        }
    }
    async save() {
        await fs.writeFile(this.file, JSON.stringify(this.state, null, 1)).catch(() => { });
    }
    /** Book one score change (rises AND falls); stage is never touched here. */
    async book(delta, reason) {
        const clamped = Math.max(-30, Math.min(30, delta));
        this.state.score = Math.max(0, Math.min(100, this.state.score + clamped));
        this.state.events.push({ time: Date.now(), delta: clamped, reason: reason.slice(0, 120) });
        if (this.state.events.length > 100)
            this.state.events = this.state.events.slice(-100);
        await this.save();
        this.log(`affection ${clamped >= 0 ? '+' : ''}${clamped} → ${this.state.score} (stage ${this.state.stage}) | ${reason}`);
        return this.state;
    }
    /** Set the stage to whatever she declares — from her memory, her truth.
     * Ascents, descents, renames: all recorded honestly in stageHistory. */
    async setStage(stage, event) {
        const target = stage.trim();
        if (target === '')
            return { ok: false, note: '阶段名为空', state: this.state };
        const from = this.state.stage;
        if (target === from)
            return { ok: false, note: `阶段已是"${from}"`, state: this.state };
        this.state.stage = target;
        this.state.stageHistory.push({ time: Date.now(), from, to: target, event: event.slice(0, 300) });
        if (this.state.stageHistory.length > 50)
            this.state.stageHistory = this.state.stageHistory.slice(-50);
        await this.save();
        this.log(`STAGE: ${from} → ${target} | ${event}`);
        return { ok: true, note: `${from} → ${target}`, state: this.state };
    }
    /** Diary list or one diary file from workspace memory/. */
    async serveDiary(params, res) {
        const date = params.get('date');
        const dir = this.workspacePath !== null ? path.join(this.workspacePath, 'memory') : null;
        if (dir === null) {
            res.writeHead(503).end(JSON.stringify({ error: 'workspace not configured' }));
            return;
        }
        try {
            if (date !== null) {
                const safe = date.replace(/[^0-9-]/g, '');
                const content = await fsp.readFile(path.join(dir, `${safe}.md`), 'utf-8');
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ date: safe, content }));
                return;
            }
            const names = [];
            for (const f of await fsp.readdir(dir)) {
                if (!f.endsWith('.md') || !/^\d{4}-\d{2}-\d{2}/.test(f))
                    continue;
                const st = await fsp.stat(path.join(dir, f));
                names.push({ date: f.slice(0, 10), mtime: st.mtimeMs });
            }
            names.sort((a, b) => b.date.localeCompare(a.date));
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ diaries: names.slice(0, 60) }));
        }
        catch (error) {
            res.writeHead(500).end(JSON.stringify({ error: String(error).slice(0, 120) }));
        }
    }
    /** Trace: the outbound message log (what she sent, what it quoted). */
    async serveTrace(params, res) {
        const sentFile = path.dirname(this.file);
        try {
            const out = {};
            const names = await fsp.readdir(sentFile).catch(() => []);
            for (const n of names) {
                if (!n.startsWith('sent-') || !n.endsWith('.json'))
                    continue;
                const entries = JSON.parse(await fsp.readFile(path.join(sentFile, n), 'utf-8'));
                out[n.replace('sent-', '').replace('.json', '')] = entries.slice(-30);
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(out));
        }
        catch (error) {
            res.writeHead(500).end(JSON.stringify({ error: String(error).slice(0, 120) }));
        }
    }
    get customHtmlPath() {
        return path.join(path.dirname(this.file), 'affection-dashboard.html');
    }
    async writeCustomHtml(html) {
        await fs.writeFile(this.customHtmlPath, html);
        this.log(`dashboard HTML updated by 我 (${html.length} bytes)`);
    }
    get tokenValue() {
        return this.token;
    }
    /** Master-only floating dashboard on loopback. */
    close() {
        this.server?.close();
        this.server = null;
    }
    serve(port, opts = {}) {
        this.configure(opts);
        const server = http.createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            if (url.pathname === '/api/affection') {
                if (url.searchParams.get('key') !== this.token) {
                    res.writeHead(403).end('forbidden');
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                res.end(JSON.stringify({ ...this.state, stageHistory: this.state.stageHistory.slice(-10), token: this.token }));
                return;
            }
            if (url.pathname === '/api/task') {
                if (url.searchParams.get('key') !== this.token) {
                    res.writeHead(403).end('forbidden');
                    return;
                }
                const prompt = url.searchParams.get('prompt') ?? '';
                if (prompt.trim() === '' || this.onSubmit === null) {
                    res.writeHead(400).end('no prompt or no submitter');
                    return;
                }
                this.onSubmit(prompt);
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, submitted: prompt.slice(0, 80) }));
                return;
            }
            if (url.pathname === '/api/diary') {
                if (url.searchParams.get('key') !== this.token) {
                    res.writeHead(403).end('forbidden');
                    return;
                }
                void this.serveDiary(url.searchParams, res);
                return;
            }
            if (url.pathname === '/api/trace') {
                if (url.searchParams.get('key') !== this.token) {
                    res.writeHead(403).end('forbidden');
                    return;
                }
                void this.serveTrace(url.searchParams, res);
                return;
            }
            if (url.pathname !== '/' && url.pathname !== '/affection') {
                res.writeHead(404).end();
                return;
            }
            // The page itself embeds the token so it can poll its own API.
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            // She owns the dashboard: serve her custom HTML when she wrote one,
            // with a live-refresh heartbeat appended (data-change-triggered reload).
            let custom = null;
            try {
                custom = readFileSync(this.customHtmlPath, 'utf-8');
            }
            catch { }
            if (custom !== null) {
                if (!custom.includes('autorefresh-shim')) {
                    custom = custom.replace(/<\/body>/i, `${REFRESH_SHIM}
</body>`);
                }
                res.end(custom);
            }
            else {
                res.end(renderPage(this.token));
            }
        });
        this.server = server;
        server.on('error', error => this.log(`dashboard unavailable: ${error.code ?? 'error'}`));
        server.listen(port, '127.0.0.1');
        this.log(`affection dashboard: http://127.0.0.1:${port}/?key=${this.token} (主人专属悬浮窗)`);
    }
}
const REFRESH_SHIM = `<script id="autorefresh-shim">
(function(){
  const KEY = new URLSearchParams(location.search).get('key') || '';
  let fp = '';
  async function check() {
    try {
      const a = await fetch('/api/affection?key=' + KEY, { cache: 'no-store' }).then(r => r.json()).catch(() => null);
      if (!a) return;
      const last = (a.events && a.events.length) ? a.events[a.events.length - 1].time + ':' + a.events[a.events.length - 1].delta : '';
      let dfp = '';
      try {
        const d = await fetch('/api/diary?key=' + KEY, { cache: 'no-store' }).then(r => r.json());
        if (d && d.diaries) dfp = d.diaries.length + ':' + (d.diaries[0] ? d.diaries[0].mtime : '');
      } catch {}
      const next = [a.score, a.stage, a.events ? a.events.length : 0, last, dfp].join('|');
      if (fp !== '' && next !== fp) { location.reload(); return; }
      fp = next;
    } catch {}
  }
  setInterval(check, 5000);
})();
</script>`;
function renderPage(token, selfName = "Assistant", masterName = "Boss") {
    return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${selfName}好感度</title>
<style>
  body { margin:0; background:#12101a; color:#f4e9ff; font-family:"Microsoft YaHei",sans-serif;
         overflow:hidden; user-select:none; }
  .wrap { padding:14px 16px; }
  .top { display:flex; align-items:baseline; gap:8px; }
  .name { font-size:15px; color:#ff9ecf; }
  .score { font-size:44px; font-weight:700; color:#ffd3ea; text-shadow:0 0 18px #ff5fb0aa; }
  .stage { font-size:13px; color:#b9a6d9; margin-top:2px; }
  .bar { height:10px; background:#2a2338; border-radius:6px; margin:10px 0 4px; overflow:hidden; }
  .fill { height:100%; border-radius:6px; transition:width .6s ease;
          background:linear-gradient(90deg,#ff5fb0,#b96bff); }
  .pct { font-size:11px; color:#8f7fae; text-align:right; }
  .log { margin-top:10px; max-height:200px; overflow-y:auto; font-size:12px; line-height:1.5; }
  .ev { padding:3px 0; border-bottom:1px dashed #2a2338; }
  .delta-pos { color:#7dffa8; } .delta-neg { color:#ff7d7d; }
  .t { color:#8f7fae; font-size:10px; margin-right:6px; }
  .reason { color:#d9cdea; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><span class="name">${selfName} → ${masterName}</span><span class="score" id="score">--</span></div>
  <div class="stage" id="stage">…</div>
  <div class="bar"><div class="fill" id="fill" style="width:0%"></div></div>
  <div class="pct" id="pct"></div>
  <div class="log" id="log"></div>
</div>
<script>
const KEY = '${token}'
async function tick() {
  try {
    const r = await fetch('/api/affection?key=' + KEY, { cache: 'no-store' })
    if (!r.ok) return
    const d = await r.json()
    document.getElementById('score').textContent = d.score
    document.getElementById('stage').textContent = d.stage
    document.getElementById('fill').style.width = d.score + '%'
    document.getElementById('pct').textContent = d.score + ' / 100'
    document.getElementById('log').innerHTML = (d.events || []).slice(-30).reverse().map(e => {
      const t = new Date(e.time).toLocaleString('zh', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      const cls = e.delta >= 0 ? 'delta-pos' : 'delta-neg'
      const sign = e.delta >= 0 ? '+' : ''
      return '<div class="ev"><span class="t">' + t + '</span><span class="' + cls + '">' + sign + e.delta + '</span> <span class="reason">' + e.reason + '</span></div>'
    }).join('')
  } catch {}
}
tick()
setInterval(tick, 5000)
</script>
</body>
</html>`;
}
