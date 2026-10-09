import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { directory, readBounded, fileSnapshot, writeApproved, listFiles, text, filename, identifier, fail, digest, utf8 } from './policy.mjs';
import { LocalTools } from './registry.mjs';

export class PhoneToolHub {
  constructor({ home, bridge, getSkills = async () => [], now = Date.now }) {
    Object.assign(this, { home, bridge, getSkills, now });
    this.registry = new LocalTools(path.join(home, 'cloud-tool-hub/tools'));
    this.config = { enabled: false, skillIds: [], toolIds: [] };
    this.tasks = new Map(); this.operations = new Map(); this.proposals = new Map(); this.events = [];
    this.online = false;
  }
  log(kind, status) { this.events.unshift({ at: this.now(), kind, status }); this.events.length = Math.min(50, this.events.length); }
  async skills() {
    return (await this.getSkills()).filter(s => s.enabled !== false && this.config.skillIds.includes(s.id ?? s.name));
  }
  async localStatus() {
    this.expire();
    return { enabled: this.config.enabled, online: this.online, skillIds: this.config.skillIds, toolIds: this.config.toolIds,
      tasks: [...this.tasks.values()].filter(t => !['stopped', 'expired'].includes(t.status)).map(t => this.taskView(t, true)),
      operations: [...this.operations.values()].filter(o => ['pending', 'approved', 'running'].includes(o.status)).map(o => this.operationView(o, true)),
      skills: (await this.getSkills()).filter(s => s.enabled !== false).map(s => ({ id: s.id ?? s.name, title: s.title || s.name, description: s.description })),
      receipts: [...this.operations.values()].filter(o => ['done', 'unknown', 'failed', 'rejected', 'cancelled'].includes(o.status)).slice(-10).reverse().map(o => this.operationView(o, true)),
      tools: await this.registry.list(), events: this.events };
  }
  taskView(t, local = false) {
    return { taskId: t.id, status: t.status, expiresAt: t.expiresAt, ...(local ? { title: t.title, packages: t.packages, owner: t.owner, minutes: t.minutes } : {}) };
  }
  operationView(o, local = false) {
    return { operationId: o.id, status: o.status, expiresAt: o.expiresAt, ...(local ? { kind: o.kind, title: this.tasks.get(o.taskId)?.title, detail: o.detail } : {}),
      ...(['done', 'unknown', 'failed', 'rejected', 'cancelled'].includes(o.status) ? { result: o.result } : {}) };
  }
  expire() {
    for (const t of this.tasks.values()) if (['pending', 'approved'].includes(t.status) && t.expiresAt <= this.now()) this.stopTask(t, 'expired');
    for (const o of this.operations.values()) if (['pending', 'approved'].includes(o.status) && o.expiresAt <= this.now()) o.status = 'cancelled';
  }
  stopTask(t, status = 'stopped') {
    t.status = status; t.abort.abort();
    for (const o of this.operations.values()) if (o.taskId === t.id && ['pending', 'approved'].includes(o.status)) o.status = 'cancelled';
    if (t.packages.length) void this.bridge.call('stop', { owner: t.owner }).catch(() => {});
    this.log('task', status);
  }
  disconnect() { this.online = false; for (const t of this.tasks.values()) if (['pending', 'approved'].includes(t.status)) this.stopTask(t); }
  task(id, approved = true) {
    this.expire(); const t = this.tasks.get(id);
    if (!t || approved && t.status !== 'approved') fail('手机任务未授权、已过期或已撤销，请在手机工具箱中确认');
    return t;
  }
  op(t, id) {
    const o = this.operations.get(id);
    if (!o || o.taskId !== t.id) fail('操作不存在或不属于当前任务');
    return o;
  }
  async approveTask(id, allow) {
    if (!this.online || !this.config.enabled) fail('AI 连接已离线或连接已暂停');
    const t = this.task(id, false);
    if (t.status !== 'pending') fail('任务已处理，请刷新');
    if (!allow) { this.stopTask(t); return; }
    await directory(t.workspace);
    this.expire(); if (t.status !== 'pending') fail('任务已撤销或过期');
    t.status = 'approved'; t.expiresAt = this.now() + t.minutes * 60000; this.log('task', 'approved');
  }
  approveOperation(id, allow) {
    this.expire(); const o = this.operations.get(id);
    if (!o || o.status !== 'pending') fail('操作已处理或过期');
    this.task(o.taskId); o.status = allow ? 'approved' : 'rejected';
    this.log(o.kind, o.status);
  }
  async propose(t, key, kind, payload, build) {
    identifier(key);
    const fingerprint = digest(JSON.stringify({ kind, payload }));
    const old = [...this.operations.values()].find(o => o.taskId === t.id && o.key === key);
    if (old) { if (old.fingerprint !== fingerprint) fail('同一请求编号不能改变操作内容'); return this.operationView(old); }
    const lock = t.id + ':' + key, pending = this.proposals.get(lock);
    if (pending) { if (pending.fingerprint !== fingerprint) fail('同一请求编号不能改变操作内容'); return pending.promise; }
    if (this.operations.size >= 200) fail('本次服务操作数已达上限，请结束任务并重启手机服务');
    if ([...this.operations.values()].filter(o => ['pending', 'approved', 'running'].includes(o.status)).length + this.proposals.size >= 8) fail('请先处理当前操作，最多同时保留8项待办');
    const promise = (async () => {
      const extra = await build(); this.task(t.id);
      const o = { id: randomUUID(), taskId: t.id, key, kind, payload: structuredClone(payload), fingerprint, status: 'pending', expiresAt: Math.min(t.expiresAt, this.now() + 300000), ...extra };
      this.operations.set(o.id, o); this.log(kind, 'pending'); return this.operationView(o);
    })();
    this.proposals.set(lock, { fingerprint, promise });
    try { return await promise; } finally { this.proposals.delete(lock); }
  }
  async execute(t, o) {
    if (o.promise) return o.promise;
    if (o.status !== 'approved') fail('此操作尚未在手机确认，或已经被拒绝/撤销');
    o.status = 'running';
    o.promise = (async () => {
      try {
        t.abort.signal.throwIfAborted();
        o.result = o.kind === 'write' ? await writeApproved(t.workspace, o.payload.filename, o.payload.content, o.before, t.abort.signal)
          : await this.registry.run(o.snapshot, o.payload.args, t.workspace, t.abort.signal);
        o.status = o.kind === 'run' && o.result.exitCode !== 0 ? 'failed' : 'done';
      } catch (error) {
        o.status = o.kind === 'run' ? 'unknown' : 'failed';
        o.result = { error: error.publicMessage || '操作未完成，请在手机检查结果；不要自动重试', doNotRetry: true };
      }
      this.log(o.kind, o.status); return this.operationView(o);
    })();
    return o.promise;
  }
  async call(name, a = {}) {
    if (!this.config.enabled) fail('手机工具箱已暂停');
    if (!a || typeof a !== 'object' || Array.isArray(a) || Buffer.byteLength(JSON.stringify(a)) > 160000) fail('工具参数无效或过大');
    if (name === 'phone_status') return { online: this.online, enabled: true, localConfirmationRequired: true, protocol: 'dsh-tools-v1', workspaceMode: 'flat-task-directory', apps: (await this.bridge.call('status', { owner: 'cloud-discovery' })).apps };
    if (name === 'phone_task_request') {
      this.expire(); const key = identifier(a.requestId);
      const title = text(a.title, '任务说明');
      const packages = a.packages ?? [];
      if (!Array.isArray(packages) || packages.length > 8 || packages.some(p => typeof p !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.]{1,180}$/.test(p))) fail('App 范围无效');
      const minutes = a.minutes ?? 10;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) fail('授权时长应为 1–30 分钟');
      const signature = digest(JSON.stringify({ title, packages, minutes }));
      const old = [...this.tasks.values()].find(t => t.key === key);
      if (old) { if (old.signature !== signature) fail('请求编号已用于其他任务'); return this.taskView(old); }
      if (this.tasks.size >= 50) fail('任务数已达上限，请结束任务并重启手机服务');
      const id = randomUUID(), t = { id, key, signature, owner: 'cloud-' + randomUUID(), title, packages: [...new Set(packages)], minutes,
        status: 'pending', expiresAt: this.now() + 300000, workspace: path.join(this.home, 'workspaces/cloud-tools', id), abort: new AbortController() };
      this.tasks.set(id, t); this.log('task', 'pending'); return this.taskView(t);
    }
    const t = this.task(a.taskId, !['phone_task_status', 'phone_task_stop', 'phone_operation_status'].includes(name));
    switch (name) {
      case 'phone_task_status': return { ...this.taskView(t), ...(t.status === 'approved' && t.packages.length ? { apps: await this.bridge.call('status', { owner: t.owner }) } : {}) };
      case 'phone_task_stop': this.stopTask(t); return this.taskView(t);
      case 'phone_workspace_list': return { files: await listFiles(t.workspace) };
      case 'phone_workspace_read': return { filename: filename(a.filename), content: utf8(await readBounded(path.join(await directory(t.workspace), filename(a.filename)))) };
      case 'phone_workspace_write': {
        const name = filename(a.filename);
        if (typeof a.content !== 'string' || Buffer.byteLength(a.content) > 131072) fail('文件内容最多 128 KiB');
        return this.propose(t, a.requestId, 'write', { filename: name, content: a.content }, async () => ({ before: await fileSnapshot(t.workspace, name), detail: { filename: name, bytes: Buffer.byteLength(a.content), content: a.content } }));
      }
      case 'phone_skill_list': return { skills: (await this.skills()).map(s => ({ id: s.id ?? s.name, title: s.title || s.name, description: s.description })) };
      case 'phone_skill_read': {
        const s = (await this.skills()).find(s => (s.id ?? s.name) === a.skillId);
        if (!s) fail('技能未在手机共享'); return { id: s.id ?? s.name, content: s.content };
      }
      case 'phone_local_tools': return { tools: (await this.registry.list()).filter(s => this.config.toolIds.includes(s.id)), execution: '手机逐次审批；可信单文件 Node 工具，拥有 App UID 权限' };
      case 'phone_local_run': {
        if (!this.config.toolIds.includes(a.toolId)) fail('此工具未在手机启用');
        const args = a.args ?? {};
        if (Buffer.byteLength(JSON.stringify(args)) > 65536) fail('脚本参数 JSON 最多64 KiB');
        return this.propose(t, a.requestId, 'run', { toolId: identifier(a.toolId), args }, async () => {
          const snapshot = await this.registry.snapshot(a.toolId, args);
          return { snapshot, detail: { toolId: a.toolId, title: snapshot.title, sha256: snapshot.sha256, args, source: snapshot.source, permission: '脚本拥有 DSH App UID 权限；仅运行你信任的本地工具' } };
        });
      }
      case 'phone_operation_status': return this.operationView(this.op(t, a.operationId));
      case 'phone_operation_execute': return this.execute(t, this.op(t, a.operationId));
      case 'phone_app_request':
        if (!t.packages.length) fail('任务没有申请 App 范围');
        return this.bridge.call('request', { owner: t.owner, task: t.title, packages: t.packages, minutes: Math.max(1, Math.floor((t.expiresAt - this.now()) / 60000)) }, t.abort.signal);
      case 'phone_app_control': {
        if (!t.packages.length) fail('任务没有 App 授权');
        const key = identifier(a.requestId), payload = a.action;
        if (!payload || typeof payload !== 'object' || !['launch', 'read', 'click', 'input', 'scroll', 'back', 'tap', 'swipe'].includes(payload.action)) fail('手机操作类型无效');
        // Receipts bind retries to immutable actions; cloud-supplied owners are ignored.
        const fingerprint = digest(JSON.stringify(payload));
        t.appReceipts ||= new Map(); const old = t.appReceipts.get(key);
        if (old) { if (old.fingerprint !== fingerprint) fail('请求编号不能改变 App 动作'); return old.promise; }
        if (t.appReceipts.size >= 200) fail('App 动作数已达上限');
        const promise = this.bridge.execute(t.owner, payload, t.abort.signal).catch(error => ({ error: error.publicMessage || error.message, doNotRetry: true }));
        t.appReceipts.set(key, { fingerprint, promise }); return promise;
      }
      default: fail('此接口不属于手机工具箱');
    }
  }
}
