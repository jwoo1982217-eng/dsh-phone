import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export class RemoteError extends Error {}
const reject = message => { throw new RemoteError(message); };
const terminal = status => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
const copy = value => structuredClone(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const short = (value, size = 2000) => typeof value === 'string' ? value.slice(0, size) : '';
const binding = config => createHash('sha256').update(config.baseUrl + '\0' + config.key).digest('hex');

export function normalizeServer(value) {
  if (typeof value !== 'string' || value.length > 2000) reject('请填写自己的 Hermes API 服务地址');
  let url; try { url = new URL(value.trim()); } catch { reject('服务器地址格式无效'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) reject('请使用 HTTPS 地址，密钥填写在单独的输入框');
  // A reverse-proxy or profile prefix is supported; append only our fixed API paths.
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  if (/%|\.\.|\\/.test(url.pathname)) reject('服务器地址路径无效');
  return url.toString().replace(/\/$/, '');
}

export class HermesRemote {
  constructor({ home, credentials, fetcher = fetch, timeout = 15000 }) {
    this.credentials = credentials; this.fetcher = fetcher; this.timeout = timeout;
    this.file = path.join(home, 'hermes-remote/conversations.json');
    this.data = { version: 1, conversations: [] }; this.config = null; this.error = ''; this.checked = null;
    this.queue = Promise.resolve();
  }
  async init() {
    try { const raw = await this.credentials.get(); if (raw) { const saved = JSON.parse(raw); this.config = { baseUrl: normalizeServer(saved.baseUrl), name: short(saved.name, 60), key: saved.key }; if (typeof saved.key !== 'string' || !saved.key || saved.key.length > 2048 || /[\r\n]/.test(saved.key)) throw Error(); } }
    catch { this.config = null; this.error = '连接配置无法读取，请重新保存'; }
    try {
      const raw = await readFile(this.file, 'utf8');
      if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw Error();
      const data = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.conversations) || data.conversations.length > 50 || data.conversations.some(c => !identifier(c.id) || !identifier(c.sessionId) || !Array.isArray(c.messages) || c.messages.length > 400)) throw Error();
      this.data = data;
    } catch (error) { if (error.code !== 'ENOENT') reject('Hermes 对话记录无法读取，已保留原文件；请从备份恢复'); }
  }
  async commit(next) {
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) reject('Hermes 对话记录已达到容量上限，请先备份并整理');
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.file); this.data = next;
    }
    finally { await rm(temp, { force: true }); }
  }
  ready() { if (!this.config) reject('先保存自己的 Hermes 服务器地址和连接密钥'); return this.config; }
  conversation(id, current = true) {
    const c = this.data.conversations.find(c => c.id === id); if (!c) reject('请先新建或选择 Hermes 对话');
    if (current && c.binding !== binding(this.ready())) reject('这段对话属于另一服务器或密钥，请恢复原连接或新建对话');
    return c;
  }
  redact(value) {
    // The server may echo its bearer key in output/errors. Never send it back to the UI.
    const key = this.config?.key;
    const visit = item => typeof item === 'string' ? (key ? item.replaceAll(key, '[连接密钥已隐藏]') : item) : Array.isArray(item) ? item.map(visit) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, visit(v)])) : item;
    return visit(value);
  }
  async request(route, { method = 'GET', body, headers = {} } = {}) {
    const config = this.ready();
    let response;
    try { response = await this.fetcher(config.baseUrl + route, { method, redirect: 'error', signal: AbortSignal.timeout(this.timeout), headers: { authorization: 'Bearer ' + config.key, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { reject('连接中断或超时，请检查服务器。已提交的任务不会自动重发'); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) reject('服务器拒绝连接，请核对 API_SERVER_KEY 和对应的 Hermes profile');
      if (response.status === 404) reject('服务器接口或任务不存在，请核对地址和 Hermes 版本');
      if (response.status === 429) reject('服务器正在限流或任务已满，请稍后刷新；任务不会自动重发');
      reject('服务器返回 HTTP ' + response.status + '，请在服务器查看日志');
    }
    const chunks = []; let bytes = 0;
    try {
      for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 1024 * 1024) reject('服务器返回内容超过 1 MB，请到服务器查看结果'); chunks.push(chunk); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) { if (error instanceof RemoteError) throw error; reject('服务器返回格式无效；请刷新核对任务状态'); }
  }
  async check() {
    const caps = await this.request('/v1/capabilities');
    if (caps.platform !== 'hermes-agent' || caps.features?.run_submission !== true || caps.features?.run_status !== true || caps.features?.run_stop !== true) reject('该地址不是支持任务查询和停止的 Hermes API 服务，请更新服务器端 Hermes');
    const idem = caps.features.runs_idempotency;
    this.checked = { binding: binding(this.config), model: short(caps.model, 200), durable: idem?.supported === true && idem?.durable === true, retention: Math.max(0, Math.min(86400, Number(idem?.retention_seconds) || 0)) };
    this.error = ''; return this.status();
  }
  status() {
    return this.redact({ configured: !!this.config, config: { baseUrl: this.config?.baseUrl ?? '', name: this.config?.name ?? '', hasKey: !!this.config?.key }, checked: this.checked, error: this.error,
      conversations: this.data.conversations.map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, available: !!this.config && c.binding === binding(this.config), messages: c.messages, run: c.run ? { id: c.run.id, status: c.run.status, error: c.run.error, output: c.run.output, runtime: c.run.runtime, usage: c.run.usage, approval: c.run.approval, lastEvent: c.run.lastEvent, recoverable: c.run.status === 'submission_unknown' && c.run.durable && Date.now() - c.run.createdAt < c.run.retention * 1000 } : null })) });
  }
  async configure(value) {
    const baseUrl = normalizeServer(value.baseUrl), key = typeof value.key === 'string' ? value.key.trim() : '';
    const next = { baseUrl, name: short(value.name, 60).trim() || '我的 Hermes', key: key || (baseUrl === this.config?.baseUrl ? this.config.key : '') };
    if (!next.key || next.key.length > 2048 || /[\r\n]/.test(next.key)) reject('请填写服务器的 API_SERVER_KEY；它与模型 API Key 是两项独立配置');
    if (this.config && binding(next) !== binding(this.config) && this.data.conversations.some(c => c.binding === binding(this.config) && c.run && !terminal(c.run.status))) reject('原连接还有未结束或结果未知的任务，请先在原服务器核对并停止');
    await this.credentials.set(JSON.stringify(next)); this.config = next; this.checked = null; this.error = ''; return this.status();
  }
  async create() {
    const config = this.ready(); if (this.data.conversations.length >= 50) reject('最多保存 50 段 Hermes 对话');
    const c = { id: randomUUID(), sessionId: 'dsh_phone_' + randomUUID().replaceAll('-', ''), binding: binding(config), title: '新 Hermes 对话', updatedAt: Date.now(), messages: [], run: null };
    await this.commit({ ...this.data, conversations: [c, ...this.data.conversations] }); return { ...this.status(), selectedId: c.id };
  }
  async submit(c) {
    const response = await this.request('/v1/runs', { method: 'POST', body: c.run.body, headers: { 'Idempotency-Key': c.run.requestId } });
    if (!identifier(response.run_id)) reject('服务器未返回有效的任务编号，请核对服务器，避免重复执行');
    const next = copy(this.data), row = next.conversations.find(x => x.id === c.id);
    row.run.id = response.run_id; row.run.status = 'running'; row.run.error = ''; row.updatedAt = Date.now();
    await this.commit(next); return this.status();
  }
  async send(id, text) {
    const c = this.conversation(id);
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 32768) reject('消息不能为空，且最多 32 KB');
    if (c.run && !terminal(c.run.status)) reject('当前任务尚未结束，请先刷新或停止，避免重复发送');
    if (c.messages.length >= 398) reject('这段对话已达到显示上限，请新建对话');
    if (this.checked?.binding !== binding(this.config)) await this.check();
    const next = copy(this.data), row = next.conversations.find(x => x.id === id);
    row.title = row.messages.length ? row.title : text.trim().slice(0, 36); row.messages.push({ role: 'user', text, at: Date.now() }); row.updatedAt = Date.now();
    // Persist the exact submission before I/O. On restart, no automatic resubmission occurs.
    row.run = { id: null, requestId: randomUUID(), body: { input: text, session_id: row.sessionId }, status: 'submission_unknown', createdAt: Date.now(), durable: this.checked.durable, retention: this.checked.retention };
    await this.commit(next);
    try { return await this.submit(row); }
    catch (error) { const failed = copy(this.data), r = failed.conversations.find(x => x.id === id); r.run.error = error instanceof RemoteError ? error.message : '任务可能已提交，但本机保存未完成，请核对服务器'; await this.commit(failed); return this.status(); }
  }
  async recover(id) {
    const c = this.conversation(id), run = c.run;
    if (!run || run.id || !run.durable || run.status !== 'submission_unknown' || Date.now() - run.createdAt >= run.retention * 1000) reject('不能安全重交此任务，请到原 Hermes 服务器核对结果');
    await this.check(); if (!this.checked.durable) reject('服务器已不支持持久去重，停止重交；请到服务器核对');
    return this.submit(c);
  }
  async refresh(id) {
    const c = this.conversation(id), run = c.run;
    if (!run?.id || terminal(run.status)) return this.status();
    const response = this.redact(await this.request('/v1/runs/' + encodeURIComponent(run.id)));
    const states = ['queued', 'started', 'running', 'waiting_for_approval', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted'];
    // Hermes resolves compressed conversations to a new live session; keep the original
    // client address and bind status by the authenticated server + exact run id.
    if (response.run_id !== run.id || !states.includes(response.status)) reject('服务器返回的任务编号或状态不匹配');
    const next = copy(this.data), row = next.conversations.find(x => x.id === id);
    row.run = { ...run, status: response.status, output: short(response.output, 200000), error: short(response.error), runtime: response.runtime, usage: response.usage, approval: response.status === 'waiting_for_approval' ? response.approval : null, lastEvent: short(response.last_event, 100) };
    if (terminal(response.status)) { row.messages.push({ role: 'assistant', text: row.run.output || (response.status === 'completed' ? '任务已完成，服务器没有返回文字结果。' : '任务结束：' + response.status + (row.run.error ? '\n' + row.run.error : '')), at: Date.now() }); row.updatedAt = Date.now(); }
    await this.commit(next); return this.status();
  }
  async stop(id) {
    const c = this.conversation(id); if (!c.run?.id || terminal(c.run.status)) reject('没有可以停止的已确认服务器任务');
    await this.request('/v1/runs/' + encodeURIComponent(c.run.id) + '/stop', { method: 'POST', body: {} });
    const next = copy(this.data); next.conversations.find(x => x.id === id).run.status = 'stopping'; await this.commit(next); return this.status();
  }
  async approve(id, requestId, choice) {
    const c = this.conversation(id), prior = c.run?.approval;
    if (!['once', 'deny'].includes(choice) || c.run?.status !== 'waiting_for_approval' || typeof requestId !== 'string' || !requestId || requestId.length > 256 || prior?.request_id !== requestId || !prior.choices?.includes(choice)) reject('确认请求无效或已变化，请刷新后重新核对');
    const fresh = this.redact(await this.request('/v1/runs/' + encodeURIComponent(c.run.id)));
    if (fresh.run_id !== c.run.id || fresh.status !== 'waiting_for_approval' || JSON.stringify(fresh.approval) !== JSON.stringify(prior)) reject('服务器确认内容已经变化，请刷新后重新核对');
    await this.request('/v1/runs/' + encodeURIComponent(c.run.id) + '/approval', { method: 'POST', body: { request_id: requestId, choice } });
    return this.refresh(id);
  }
  async disconnect() {
    // Only forget the connection. The UI warns that this is not a server-side stop.
    await this.credentials.set(''); this.config = null; this.checked = null; return this.status();
  }
  call(action, value = {}) {
    const operation = this.queue.then(async () => {
      switch (action) {
        case 'status': return this.status();
        case 'configure': return this.configure(value);
        case 'check': return this.check();
        case 'create': return this.create();
        case 'send': return this.send(value.id, value.text);
        case 'refresh': return this.refresh(value.id);
        case 'recover': return this.recover(value.id);
        case 'stop': return this.stop(value.id);
        case 'approve': return this.approve(value.id, value.requestId, value.choice);
        case 'disconnect': return this.disconnect();
        default: reject('无效的 Hermes 操作');
      }
    });
    this.queue = operation.catch(() => {}); return operation;
  }
}
