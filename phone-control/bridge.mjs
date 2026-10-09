import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

/** Length-prefixed requests, bounded EOF-delimited JSON responses. Never retries. */
export class NativeControlBridge {
  constructor(socket = process.env.DSH_PHONE_CONTROL_SOCKET, { connect = createConnection, timeout = 22000 } = {}) {
    this.socket = socket; this.connect = connect; this.timeout = timeout;
  }
  async call(command, fields = {}, signal) {
    if (!this.socket) throw Error('此功能需要带原生手机操作模块的 Android APK；电脑模式不提供手机控制');
    signal?.throwIfAborted();
    const request = { ...fields, command }, body = Buffer.from(JSON.stringify(request));
    if (body.length > 65536) throw Error('手机操作请求过大');
    const frame = Buffer.alloc(4 + body.length); frame.writeUInt32BE(body.length); body.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const socket = this.connect({ path: this.socket.startsWith('/') ? this.socket : '\0' + this.socket });
      let settled = false, size = 0, chunks = [];
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => {
        if (command === 'execute' && fields.owner && fields.requestId) void this.call('cancel', { owner: fields.owner, requestId: fields.requestId }).catch(() => {});
      };
      const abort = () => { cancel(); finish(signal.reason instanceof Error ? signal.reason : Error('手机操作已取消')); };
      const timer = setTimeout(() => { cancel(); finish(Error('手机操作结果超时，结果未知；请先查看当前 App，勿自动重试提交动作')); }, this.timeout);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      socket.once('connect', () => { if (!settled) socket.end(frame); });
      socket.on('data', chunk => { size += chunk.length; if (size > 512 * 1024) { cancel(); finish(Error('手机界面结果过大')); } else chunks.push(chunk); });
      socket.once('error', error => { cancel(); finish(Error('原生手机操作模块连接失败：' + error.code)); });
      socket.once('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (result.ok !== true) throw Error(result.error || '手机操作未完成');
          finish(null, result.value);
        } catch (error) { finish(error); }
      });
      socket.once('close', () => { if (!settled) { cancel(); finish(Error('手机操作连接中断，结果未知；不要自动重复动作')); } });
    });
  }
  async execute(owner, args, signal) {
    const status = await this.call('status', { owner }, signal);
    let grant = status.grant;
    if (!grant) throw Error('请使用 DSH 手机工具同步现有会话权限');
    return this.call('execute', { owner, epoch: grant.epoch, requestId: randomUUID(), args }, signal);
  }
}
