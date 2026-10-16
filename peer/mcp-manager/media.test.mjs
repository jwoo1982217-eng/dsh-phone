import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { MediaService } from './media.mjs';
import { MediaApi, networkError } from './media-api.mjs';
import { registerMediaFiles } from './media-http.mjs';
import { publicMediaUrl } from './media-files.mjs';
import { McpManager } from './manager.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k7S8AAAAASUVORK5CYII=', 'base64');
const mp4 = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(24)]);
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-media-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const history = []; let secret = 'fixture-old-key', failQuery = false, httpStatus = 200;
  const ctx = { settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { agnes: { baseURL: 'https://apihub.agnes-ai.com/v1', apiKeyEnv: 'FIXTURE_AGNES' } } } }] },
    credentials: { resolve: async () => ({ value: secret }) }, get: () => undefined, on: () => {}, tools: { guard: () => {} }, sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) } };
  const fetchImpl = async (url, init) => {
    history.push({ url: String(url), headers: init.headers, body: init.body && JSON.parse(init.body) });
    if (String(url).includes('/agnesapi?') && failQuery) throw Object.assign(Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    let data = String(url).endsWith('/models') ? { data: [{ id: 'agnes-image-2.1-flash' }, { id: 'agnes-video-2.5-flash' }, { id: 'agnes-3.0-flash' }] }
      : String(url).endsWith('/images/generations') ? { data: [{ b64_json: png.toString('base64') }] }
      : String(url).endsWith('/videos') ? { video_id: 'video_fixture', id: 'task_other_id', status: 'queued' }
      : { status: 'completed', progress: 100, url: 'https://media.example.invalid/output.mp4' };
    return new Response(JSON.stringify(data), { status: httpStatus });
  };
  const service = new MediaService(ctx, home, { fetchImpl, download: async () => mp4 });
  const exec = { agent: { session: { id: 'session-media', header: { cwd: home } } }, signal: new AbortController().signal };
  return { home, ctx, service, exec, history, fetchImpl, rotate: () => { secret = 'fixture-new-key'; }, fail: v => { failQuery = v; }, status: v => { httpStatus = v; } };
}
test('real media request shapes, private credential resolution and local image receipt', async t => {
  const f = fixture(t), models = await f.service.call('list_models', {}, f.exec); assert.equal(models.models.length, 2);
  const result = await f.service.call('generate_image', { prompt: 'test image' }, f.exec);
  assert.equal(result.status, 'completed'); assert.equal(result.mimeType, 'image/png'); assert.ok(fs.readFileSync(result.file).equals(png));
  const request = f.history.find(x => x.body?.prompt); assert.equal(request.url, 'https://apihub.agnes-ai.com/v1/images/generations');
  assert.equal(request.body.return_base64, true); assert.deepEqual(request.body.extra_body, { response_format: 'b64_json' });
  assert.equal(request.headers.Authorization, 'Bearer fixture-old-key');
  assert.ok(!fs.readFileSync(path.join(f.home, 'storage/media/jobs', result.jobId, 'job.json'), 'utf8').includes('fixture-old-key'));
});
test('video survives restart, uses video_id and current credential, DNS failure does not resubmit', async t => {
  const f = fixture(t); const first = await f.service.call('generate_video', { prompt: 'test video', seconds: 4 }, f.exec);
  assert.equal(first.videoId, 'video_fixture'); assert.equal(f.history.filter(x => x.body?.prompt).length, 1);
  const restarted = new MediaService(f.ctx, f.home, { fetchImpl: f.fetchImpl, download: async () => mp4 });
  f.fail(true); let result = await restarted.call('result', { jobId: first.jobId }, f.exec);
  assert.equal(result.status, 'queued'); assert.match(result.lastError, /ENOTFOUND/); assert.equal(result.videoId, first.videoId);
  f.rotate(); f.fail(false); result = await restarted.call('result', { jobId: first.jobId }, f.exec);
  assert.equal(result.status, 'completed'); assert.ok(fs.readFileSync(result.file).equals(mp4));
  const last = f.history.at(-1); assert.ok(last.url.includes('video_id=video_fixture&model_name=agnes-video-2.5-flash'));
  assert.equal(last.headers.Authorization, 'Bearer fixture-new-key'); assert.equal(f.history.filter(x => x.body?.prompt).length, 1);
});
test('window ownership, read-only permission, provider access and reference limits fail before paid submission', async t => {
  const f = fixture(t); f.ctx.sandboxPolicy.resolve = () => ({ mode: 'read-only' });
  await assert.rejects(f.service.call('generate_video', { prompt: 'x' }, f.exec), /完全权限/); assert.equal(f.history.length, 0);
  f.ctx.sandboxPolicy.resolve = () => ({ mode: 'danger-full-access' });
  await assert.rejects(f.service.call('generate_video', { prompt: 'x', images: Array(6).fill('https://example.com/a.png') }, f.exec), /最多5/);
  const job = await f.service.call('generate_video', { prompt: 'x' }, f.exec);
  const other = { ...f.exec, agent: { session: { id: 'session-other', header: { cwd: f.home } } } };
  await assert.rejects(f.service.call('result', { jobId: job.jobId }, other), /不属于/);
  f.ctx.credentials.resolve = async () => undefined; await assert.rejects(f.service.call('list_models', {}, f.exec), /没有可用凭据/);
  assert.equal(f.history.filter(x => x.body?.prompt).length, 1);
});
test('unknown submission and server errors preserve evidence without blind retry', async t => {
  const f = fixture(t); f.status(401); await assert.rejects(f.service.call('generate_image', { prompt: 'x' }, f.exec), /HTTP 401/);
  f.status(200); f.service.api.fetch = async (url, init) => String(url).endsWith('/models') ? f.fetchImpl(url, init) : Promise.reject(Object.assign(Error('fetch failed'), { cause: { code: 'ECONNRESET' } }));
  await assert.rejects(f.service.call('generate_video', { prompt: 'x' }, f.exec), /ECONNRESET/);
  const job = f.service.jobs()[0]; assert.equal(job.status, 'unknown');
  const restarted = new MediaService(f.ctx, f.home, { fetchImpl: f.fetchImpl }); assert.equal((await restarted.call('result', { jobId: job.id }, f.exec)).status, 'unknown');
  assert.match(networkError({ name: 'TimeoutError' }), /不要自动重新提交/);
});
test('media file endpoint requires auth, rejects traversal and supports exact video ranges', async t => {
  const f = fixture(t), job = await f.service.call('generate_video', { prompt: 'x' }, f.exec);
  const result = await f.service.call('result', { jobId: job.jobId }, f.exec); let registered;
  registerMediaFiles({ effect: fn => fn(), webServer: { register: r => { registered = r; } }, connection: { requestRejection: req => req.headers.authorization === 'fixture-human' ? undefined : 401 } }, f.service);
  const server = createServer(registered.handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = 'http://127.0.0.1:' + server.address().port + result.previewUrl;
  assert.equal((await fetch(url)).status, 401);
  let r = await fetch(url, { headers: { Authorization: 'fixture-human', Range: 'bytes=4-11' } }); assert.equal(r.status, 206); assert.equal(await r.text(), 'ftypisom');
  r = await fetch(url.replace(job.jobId, '..%2f.credentials.yaml'), { headers: { Authorization: 'fixture-human' } }); assert.equal(r.status, 404);
  await assert.rejects(publicMediaUrl('https://127.0.0.1/a'), /私有网络/);
});
test('existing external media service and disabled flags survive built-in migration', t => {
  const f = fixture(t), file = path.join(f.home, 'storage/mcp-manager/config.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 5, pricing: {}, servers: [{ id: 'media', transport: 'stdio', command: 'custom', enabled: false }] }));
  const m = new McpManager(f.ctx, f.home); assert.equal(m.config.revision, 5); assert.equal(m.config.servers.length, 1); assert.equal(m.config.servers[0].command, 'custom'); assert.equal(m.config.servers[0].enabled, false);
});
