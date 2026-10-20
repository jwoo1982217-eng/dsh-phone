import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check, hash, localCaller, policyOf, read, save } from './common.mjs';
import { objectSchema } from './router.mjs';
import { MediaApi, mediaProvider } from './media-api.mjs';
import { JOB_ID, jobDirectory, downloadMedia, writeMedia } from './media-files.mjs';
import { beginSpeech, speechResult, speechCapability } from './media-speech.mjs';

const text = { type: 'string', minLength: 1, maxLength: 12000 }, model = { type: 'string', maxLength: 100 };
const images = { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 2048 } };
const required = (props, fields) => ({ ...objectSchema(props), required: fields });
export const MEDIA_TOOLS = [
  { name: 'list_models', description: '读取本设备已配置 Agnes 接口的实际图片/视频模型和系统朗读能力；没有独立音乐生成模型。', annotations: { readOnlyHint: true }, inputSchema: objectSchema({}) },
  { name: 'generate_image', description: '文生图或用公网HTTPS参考图编辑/合成图片。自动复用当前 Agnes 凭据，保存本地图片和任务记录；失败不会自动重发。', inputSchema: required({ prompt: text, model, size: { type: 'string', enum: ['1K', '2K', '3K', '4K'] }, ratio: { type: 'string', enum: ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'] }, images }, ['prompt']) },
  { name: 'generate_video', description: '提交4至12秒720P Agnes Flash视频，支持文生视频和公网HTTPS图片参考；立即返回本地jobId。随后用result查询，不能重复提交来等待。任务和video_id跨重启保留。', inputSchema: required({ prompt: text, seconds: { type: 'integer', minimum: 4, maximum: 12 }, ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] }, images }, ['prompt']) },
  { name: 'generate_audio', description: '用本设备系统语音引擎把文字合成朗读WAV。默认中文；返回jobId后用result查询。音频能力仅语音合成，音乐/音色克隆需另接相应服务。', inputSchema: required({ text: { type: 'string', minLength: 1, maxLength: 4000 }, language: { type: 'string', maxLength: 30 }, voice: { type: 'string', maxLength: 160 } }, ['text']) },
  { name: 'result', description: '查询当前项目窗口自己的媒体jobId，取回进度和已生成文件。网络错误保留已有视频ID，可稍后查询；不会重新提交生成。', annotations: { readOnlyHint: true }, inputSchema: required({ jobId: { type: 'string', maxLength: 36 } }, ['jobId']) },
];
function inputImages(value) {
  const rows = value || []; check(Array.isArray(rows) && rows.length <= 5, '参考图最多5张');
  return rows.map(s => { check(typeof s === 'string' && s.length <= 2048, '参考图地址无效'); const u = new URL(s); check(u.protocol === 'https:' && !u.username && !u.password && !u.hash, '参考图请使用可公开访问的HTTPS地址'); return u.href; });
}
export class MediaService {
  constructor(ctx, home, options = {}) {
    this.ctx = ctx; this.home = home; this.api = new MediaApi(ctx, options); this.locks = new Map(); this.pending = new Map();
    this.download = options.download || downloadMedia; this.speech = options.speech || beginSpeech; this.closed = false;
    for (const job of this.jobs()) if (job.status === 'submitting' || job.status === 'in_progress' && job.kind !== 'video' && !job.nativeSpeech) {
      job.status = 'unknown'; job.error = 'DSH在结果确认前重启；未自动重复生成。请检查服务侧结果后再决定是否新建任务'; this.store(job);
    }
  }
  jobs() {
    const root = path.join(this.home, 'storage/media/jobs'); if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter(id => JOB_ID.test(id)).slice(0, 1000).map(id => read(path.join(jobDirectory(this.home, id), 'job.json'), null)).filter(Boolean);
  }
  store(job) { save(path.join(jobDirectory(this.home, job.id), 'job.json'), job); }
  load(id) { check(typeof id === 'string' && JOB_ID.test(id), '媒体任务标识无效'); const job = read(path.join(this.home, 'storage/media/jobs', id, 'job.json'), null); check(job, '媒体任务不存在'); return job; }
  public(job) { const { prompt, window, videoId, ...view } = job; return { ...view, ...(videoId ? { videoId } : {}), ...(job.previewUrl ? { url: 'http://127.0.0.1:3080' + job.previewUrl } : {}), ...(job.status === 'queued' || job.status === 'in_progress' ? { next: '用 mcp__media__result 查询此 jobId，不要重复提交', pollAfterSeconds: 5 } : {}), jobId: job.id }; }
  status() { return { provider: mediaProvider(this.ctx)?.id || null, audio: speechCapability(), jobs: this.jobs().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map(j => this.public(j)), directory: path.join(this.home, 'storage/media/jobs') }; }
  create(owner, kind, prompt, model, provider) {
    const jobs = this.jobs(); check(jobs.length < 1000, '媒体记录已达1000条，请先整理已完成结果');
    const active = jobs.filter(j => ['queued', 'in_progress', 'submitting'].includes(j.status));
    check(active.length < 4 && active.filter(j => j.window === hash(owner.cwd + '\0' + owner.id)).length < 2, '已有媒体任务处理中，请先取回结果');
    const job = { id: randomUUID(), window: hash(owner.cwd + '\0' + owner.id), sessionId: owner.id, projectPath: owner.cwd, kind, prompt, model, provider, createdAt: new Date().toISOString(), status: 'submitting', cost: { known: false } };
    this.store(job); return job;
  }
  async call(name, args, exec) {
    check(!this.closed, '媒体服务已关闭'); const owner = localCaller(exec);
    if (name === 'list_models') return { ...await this.api.models(exec.signal), audio: speechCapability() };
    if (name === 'result') return this.result(args.jobId, owner, exec.signal);
    check(policyOf(this.ctx, exec).mode === 'danger-full-access', '媒体生成请使用当前聊天已有的完全权限模式');
    check(['generate_image', 'generate_video', 'generate_audio'].includes(name), '未知媒体工具');
    const prompt = name === 'generate_audio' ? args.text : args.prompt;
    check(typeof prompt === 'string' && prompt.trim() && prompt.length <= (name === 'generate_audio' ? 4000 : 12000), '生成文字为空或过长');
    if (name === 'generate_audio') {
      check(!args.language || /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(args.language), '语言代码无效');
      check(!args.voice || typeof args.voice === 'string' && args.voice.length <= 160 && !/[\r\n]/.test(args.voice), '音色名称无效');
      const job = this.create(owner, 'audio', prompt, 'system-tts', 'system'); job.status = 'in_progress'; job.nativeSpeech = process.env.DSH_PHONE_ANDROID === '1'; this.store(job);
      const work = this.speech(this.home, job, args, exec.signal).then(value => { Object.assign(job, value); if (!value.nativeSpeech) job.status = 'completed'; this.store(job); }).catch(error => { job.status = 'failed'; job.error = error.message.slice(0, 300); this.store(job); }).finally(() => this.pending.delete(job.id));
      this.pending.set(job.id, work); return this.public(job);
    }
    const refs = inputImages(args.images), p = await this.api.provider();
    const catalog = await this.api.models(exec.signal);
    const chosen = name === 'generate_image' ? args.model || 'agnes-image-2.1-flash' : 'agnes-video-2.5-flash';
    check(catalog.models.some(x => x.id === chosen && x.kind === (name === 'generate_image' ? 'image' : 'video')), '本接口模型目录没有请求的媒体模型');
    const seconds = args.seconds ?? 4; check(Number.isInteger(seconds) && seconds >= 4 && seconds <= 12, '视频时长为4至12秒');
    const ratio = args.ratio || (name === 'generate_image' ? '1:1' : '16:9');
    check(['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'].includes(ratio), '画面比例无效');
    const size = args.size || '1K'; check(['1K', '2K', '3K', '4K'].includes(size), '图片尺寸无效');
    const job = this.create(owner, name === 'generate_image' ? 'image' : 'video', prompt, chosen, p.id);
    try {
      if (job.kind === 'image') {
        const data = await this.api.request(p, 'images/generations', { model: chosen, prompt, size, ratio, ...(refs.length ? {} : { return_base64: true }), extra_body: { ...(refs.length ? { image: refs } : {}), response_format: 'b64_json' } }, exec.signal, 330000);
        const row = data.data?.[0]; check(row && (typeof row.b64_json === 'string' || typeof row.url === 'string'), '接口没有返回图片');
        const bytes = row.b64_json ? Buffer.from(row.b64_json, 'base64') : await this.download(row.url, exec.signal);
        Object.assign(job, writeMedia(this.home, job.id, bytes, 'image'), { status: 'completed' });
      } else {
        const data = await this.api.request(p, 'videos', { model: chosen, prompt, seconds: String(seconds), size: '720P', aspect_ratio: ratio, n: 1, mode: refs.length ? 'reference' : 'text', ...(refs.length ? { images: refs } : {}) }, exec.signal);
        check(typeof data.video_id === 'string' && data.video_id.length <= 200, '提交响应没有video_id，结果未知；不要自动重复提交');
        job.videoId = data.video_id; job.status = data.status === 'failed' ? 'failed' : 'queued'; job.progress = Number(data.progress) || 0;
      }
      this.store(job); return this.public(job);
    } catch (error) { job.status = error.status ? 'failed' : 'unknown'; job.error = error.message.slice(0, 300); this.store(job); throw Error(error.message + '；任务记录：' + job.id); }
  }
  async result(id, owner, signal) {
    const job = this.load(id); check(job.window === hash(owner.cwd + '\0' + owner.id), '媒体任务不属于当前项目窗口');
    if (this.locks.has(id)) return this.locks.get(id);
    const operation = this.refresh(job, signal).finally(() => this.locks.delete(id)); this.locks.set(id, operation); return operation;
  }
  async refresh(job, signal) {
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'unknown') return this.public(job);
    if (this.pending.has(job.id)) return this.public(job);
    try {
      if (job.kind === 'audio' && job.nativeSpeech) {
        const value = await speechResult(this.home, job, signal); Object.assign(job, value);
      } else if (job.kind === 'video' && job.videoId) {
        const p = await this.api.provider(job.provider), data = await this.api.request(p, '/agnesapi?' + new URLSearchParams({ video_id: job.videoId, model_name: job.model }), undefined, signal);
        check(['queued', 'in_progress', 'completed', 'failed'].includes(data.status), '视频查询状态无效');
        job.progress = Number(data.progress) || 0;
        if (data.status === 'completed') {
          check(typeof data.url === 'string', '已完成视频没有结果地址');
          job.resultUrl = data.url; this.store(job);
          Object.assign(job, writeMedia(this.home, job.id, await this.download(data.url, signal), 'video'), { status: 'completed' });
        } else { job.status = data.status; if (job.status === 'failed') job.error = '上游视频生成失败，未自动重新提交'; }
      }
      delete job.lastError;
    } catch (error) { job.lastError = error.message.slice(0, 300); }
    this.store(job); return this.public(job);
  }
  async close() { this.closed = true; await Promise.allSettled([...this.pending.values()]); }
}
