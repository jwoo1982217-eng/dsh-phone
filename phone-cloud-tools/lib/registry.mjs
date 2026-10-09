import { readdir, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { directory, readBounded, identifier, digest, text, validateArguments, fail } from './policy.mjs';

/** Registered single-file Node tools are trusted App-UID code, never an OS sandbox. */
export class LocalTools {
  constructor(root) { this.root = root; }
  async install(bundle) {
    const id = identifier(bundle?.id);
    if (typeof bundle.source !== 'string' || Buffer.byteLength(bundle.source) > 131072) fail('工具源码最多128 KiB');
    const manifest = { id, title: text(bundle.title, '工具名称', 100), description: text(bundle.description, '工具说明'), entry: 'tool.mjs', inputSchema: bundle.inputSchema };
    // Validate schema with a supplied example so unsupported definitions cannot
    // silently become an executable tool. This is shape checking, not trust review.
    validateArguments(manifest.inputSchema, bundle.exampleArgs ?? {});
    await directory(this.root);
    const temp = path.join(this.root, '.import-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    await mkdir(temp, { mode: 0o700 });
    try {
      await writeFile(path.join(temp, 'tool.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      await writeFile(path.join(temp, 'tool.mjs'), bundle.source, { mode: 0o600 });
      // No overwrites: an existing tool/version stays recoverable.
      await rename(temp, path.join(this.root, id));
    } catch { fail('工具已存在或无法保存；请用新的工具 ID 导入，旧版保留'); }
    finally { await rm(temp, { recursive: true, force: true }); }
    return this.snapshot(id);
  }
  async list() {
    await directory(this.root);
    const result = [];
    for (const id of (await readdir(this.root)).filter(id => !id.startsWith('.')).slice(0, 50)) {
      try { const tool = await this.snapshot(id); result.push({ id, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, sha256: tool.sha256 }); }
      catch { /* Invalid or symbolic-link packages are unavailable, never executed. */ }
    }
    return result;
  }
  async snapshot(id, args) {
    identifier(id);
    const folder = path.join(this.root, id);
    await directory(folder);
    const manifest = JSON.parse((await readBounded(path.join(folder, 'tool.json'), 16384)).toString());
    if (manifest.id !== id || manifest.entry !== 'tool.mjs') fail('本地工具清单无效');
    const source = await readBounded(path.join(folder, 'tool.mjs'), 131072);
    if (args !== undefined) validateArguments(manifest.inputSchema, args);
    return { id, title: text(manifest.title, '工具名称', 100), description: text(manifest.description, '工具说明', 500),
      inputSchema: manifest.inputSchema, source: source.toString('utf8'), sha256: digest(Buffer.concat([Buffer.from(JSON.stringify(manifest)), source])) };
  }
  async run(snapshot, args, cwd, signal) {
    signal.throwIfAborted();
    await directory(cwd);
    const env = { PATH: process.env.PATH ?? '', HOME: cwd, TMPDIR: cwd, OPENSSL_CONF: '/dev/null' };
    if (process.env.LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH;
    // Execute the exact bytes shown for approval. No remote command, path, or env.
    const child = spawn(process.execPath, ['--input-type=module', '-', JSON.stringify(args)], { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
      let total = 0, output = [], errors = [], settled = false;
      const finish = (error, result) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(result);
      };
      // Wait for process exit on cancellation. A stopped process may have committed
      // side effects already; its operation receipt must never be re-executed.
      let stopReason;
      const stop = reason => {
        stopReason ||= reason;
        try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); }
        catch { child.kill('SIGKILL'); }
      };
      const abort = () => stop('任务已撤销；脚本结果未知，请检查产物，不要自动重跑');
      const timer = setTimeout(() => stop('脚本超时；结果未知，请检查产物，不要自动重跑'), 30000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const collect = destination => chunk => { total += chunk.length; if (total > 65536) stop('脚本输出过大；结果未知'); else destination.push(chunk); };
      child.stdout.on('data', collect(output)); child.stderr.on('data', collect(errors)); child.stdin.on('error', () => {});
      child.once('error', () => finish(new Error('本地脚本无法启动')));
      child.once('close', code => {
        if (stopReason) finish(Object.assign(new Error(stopReason), { publicMessage: stopReason }));
        else finish(null, { exitCode: code, stdout: Buffer.concat(output).toString(), stderr: Buffer.concat(errors).toString(), toolSha256: snapshot.sha256 });
      });
      child.stdin.end(snapshot.source);
    });
  }
}
